import { Router, type Request, type Response } from 'express';
import {
  askRequestSchema,
  notesToCardsRequestSchema,
  type AiStatus,
  type AiStreamEvent,
} from '@huddle/shared';
import type { AppDeps } from '../deps';
import { requireBoardPermission } from '../http/access';
import { authOf } from '../http/auth-middleware';
import { HttpError } from '../http/errors';
import { createRateLimiter } from '../http/rate-limit';
import { parse } from '../http/validate';
import { BudgetExceededError, periodResetsAt } from './budget';
import { AiError } from './service';

/** Aborts when the HTTP client disconnects, so we stop paying for tokens nobody reads. */
function clientAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new DOMException('client closed', 'AbortError'));
  });
  req.on('aborted', () => controller.abort(new DOMException('client closed', 'AbortError')));
  return controller.signal;
}

function budgetError(err: BudgetExceededError, res: Response): never {
  const retryAfter = Math.max(1, Math.ceil((err.resetsAt.getTime() - Date.now()) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  throw new HttpError(429, 'ai_budget_exceeded', err.message, {
    remaining: err.decision.remaining,
    resetsAt: err.resetsAt.toISOString(),
  });
}

export function aiRouter(deps: AppDeps): Router {
  const { ai, db, config } = deps;
  const router = Router();
  router.use(deps.requireAuth);

  const limiter = createRateLimiter(
    deps.redis,
    {
      keyPrefix: 'ai',
      points: config.AI_RATE_LIMIT_PER_MINUTE,
      durationSeconds: 60,
      key: (req) => authOf(req).userId,
      message: 'Too many AI requests. Wait a moment and try again.',
    },
    config.RATE_LIMIT_DISABLED && !config.AI_RATE_LIMIT_ENFORCED,
  );

  router.get('/ai/status', async (req, res) => {
    const snapshot = await ai.budget.snapshot(authOf(req).userId);
    const body: AiStatus = {
      provider: ai.service.provider.name,
      model: ai.service.provider.model,
      budget: {
        used: snapshot.used,
        reserved: snapshot.reserved,
        limit: snapshot.limit,
        period: snapshot.period,
        resetsAt: periodResetsAt().toISOString(),
      },
    };
    res.json(body);
  });

  router.post('/boards/:boardId/ai/notes-to-cards', limiter, async (req, res) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'ai:write');
    const { notes } = parse(notesToCardsRequestSchema, req.body);
    try {
      const result = await ai.service.notesToCards(
        userId,
        { boardId: access.boardId, workspaceId: access.workspaceId, title: access.title },
        notes,
        clientAbortSignal(req, res),
      );
      res.json(result);
    } catch (err) {
      if (err instanceof BudgetExceededError) budgetError(err, res);
      if (err instanceof AiError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  /**
   * Server-Sent Events over a POST (the browser reads it with fetch + a
   * stream reader; EventSource cannot send a body or Authorization header).
   */
  const streamHandler = (feature: 'summary' | 'ask') => async (req: Request, res: Response) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'ai:read');
    const question = feature === 'ask' ? parse(askRequestSchema, req.body).question : undefined;
    // Budget is checked before switching to SSE so it can be a plain 429.
    const signal = clientAbortSignal(req, res);
    let started = false;
    const send = (e: AiStreamEvent) => {
      if (!started) {
        started = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // Disable proxy buffering (nginx) so tokens reach the browser live.
          'X-Accel-Buffering': 'no',
        });
      }
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    const heartbeat = setInterval(() => started && res.write(': keep-alive\n\n'), 15_000);
    try {
      await ai.service.stream(
        feature,
        userId,
        { boardId: access.boardId, workspaceId: access.workspaceId, title: access.title },
        question,
        signal,
        send,
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) budgetError(err, res);
      throw err;
    } finally {
      clearInterval(heartbeat);
      if (started) res.end();
    }
  };

  router.post('/boards/:boardId/ai/summary', limiter, streamHandler('summary'));
  router.post('/boards/:boardId/ai/ask', limiter, streamHandler('ask'));

  return router;
}
