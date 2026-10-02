import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { aiRequests, loadBoardDoc, users, workspaceMembers, type Database } from '@huddle/db';
import {
  notesToCardsJsonSchema,
  type AiStreamEvent,
  type CardProposal,
  type NotesToCardsOutput,
  type NotesToCardsResponse,
} from '@huddle/shared';
import { readBoard } from '@huddle/shared/board';
import type { Logger } from '../logger';
import type { ApiMetrics } from '../metrics';
import type { BudgetStore } from './budget';
import { estimatePromptTokens, worstCaseTokens, type Reservation } from './budget';
import { buildBoardContext, resolveCitations, type BoardContext } from './context';
import { parseNotesToCards } from './parse';
import {
  ASK_SYSTEM,
  NOTES_TO_CARDS_SYSTEM,
  SUMMARY_SYSTEM,
  boardPrompt,
  notesToCardsUserPrompt,
  retryPrompt,
} from './prompts';
import {
  LlmRefusalError,
  LlmUnavailableError,
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
} from './providers/types';

export type AiFeature = 'notes_to_cards' | 'summary' | 'ask';

export class AiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const LIMITS = {
  notes_to_cards: { maxTokens: 8000, effort: 'medium', attempts: 2 },
  summary: { maxTokens: 4000, effort: 'low', attempts: 1 },
  ask: { maxTokens: 3000, effort: 'low', attempts: 1 },
} as const;

export interface BoardRef {
  boardId: string;
  workspaceId: string;
  title: string;
}

export class AiService {
  constructor(
    private readonly deps: {
      db: Database;
      provider: LlmProvider;
      budget: BudgetStore;
      metrics: ApiMetrics;
      logger: Logger;
      timeoutMs: number;
    },
  ) {}

  get provider() {
    return this.deps.provider;
  }

  // -------------------------------------------------------------------------
  // Notes -> cards (structured output, validated, one corrective retry)
  // -------------------------------------------------------------------------

  async notesToCards(
    userId: string,
    board: BoardRef,
    notes: string,
    clientSignal: AbortSignal,
  ): Promise<NotesToCardsResponse> {
    const feature: AiFeature = 'notes_to_cards';
    const started = performance.now();
    const { view, members } = await this.loadBoard(board);
    const today = new Date().toISOString().slice(0, 10);
    const userPrompt = notesToCardsUserPrompt({
      notes,
      columns: view.columns.map((c) => c.title),
      members: members.map((m) => m.name),
      today,
    });
    const limits = LIMITS[feature];
    const promptTokens = estimatePromptTokens(NOTES_TO_CARDS_SYSTEM, userPrompt);
    // Reserve for every attempt we might make (the retry resends the prompt).
    const reservation = await this.deps.budget.reserve(
      userId,
      worstCaseTokens(promptTokens, limits.maxTokens, limits.attempts),
    );

    const total: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let attempts = 0;
    let status = 'ok';
    let model = this.deps.provider.model;
    const { signal, didTimeout, cleanup } = this.deadline(clientSignal);
    try {
      const messages: LlmMessage[] = [{ role: 'user', content: userPrompt }];
      let lastError = '';
      while (attempts < limits.attempts) {
        attempts += 1;
        const result = await this.deps.provider.completeJson({
          system: NOTES_TO_CARDS_SYSTEM,
          messages,
          maxTokens: limits.maxTokens,
          effort: limits.effort,
          jsonSchema: notesToCardsJsonSchema as unknown as Record<string, unknown>,
          signal,
        });
        model = result.model;
        total.inputTokens += result.usage.inputTokens;
        total.outputTokens += result.usage.outputTokens;
        const parsed = parseNotesToCards(result.text);
        if (parsed.ok) {
          const resolved = this.resolveProposals(parsed.data, view, members);
          return { ...resolved, usage: total, attempts };
        }
        lastError = parsed.error;
        this.deps.logger.warn(
          { feature, attempt: attempts, issues: parsed.error },
          'invalid AI output',
        );
        // Corrective retry: show the model its own answer and what was wrong.
        messages.push(
          { role: 'assistant', content: result.text.slice(0, 20_000) || '(empty)' },
          { role: 'user', content: retryPrompt(parsed.error) },
        );
      }
      status = 'invalid_output';
      throw new AiError(
        502,
        'ai_invalid_output',
        `The AI returned an invalid answer ${attempts} times. Try rephrasing the notes. (${lastError.split('\n')[0]})`,
      );
    } catch (err) {
      if (status === 'ok') status = this.statusOf(err, didTimeout());
      throw this.toAiError(err, didTimeout());
    } finally {
      cleanup();
      await this.finish({
        userId,
        board,
        feature,
        reservation,
        total,
        attempts,
        status,
        model,
        started,
      });
    }
  }

  private resolveProposals(
    output: NotesToCardsOutput,
    view: ReturnType<typeof readBoard>,
    members: Array<{ userId: string; name: string }>,
  ): { proposals: CardProposal[]; warnings: string[] } {
    const warnings: string[] = [];
    const firstColumn = view.columns[0];
    if (!firstColumn) return { proposals: [], warnings: ['The board has no columns'] };
    const byTitle = new Map(view.columns.map((c) => [c.title.trim().toLowerCase(), c]));
    const proposals = output.cards.map((card): CardProposal => {
      let column = byTitle.get(card.column.trim().toLowerCase());
      if (!column) {
        warnings.push(
          `"${card.title}": unknown column "${card.column}", using "${firstColumn.title}"`,
        );
        column = firstColumn;
      }
      const assignees: CardProposal['assignees'] = [];
      for (const name of card.assignees) {
        const match = members.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
        if (match) assignees.push(match);
        else warnings.push(`"${card.title}": "${name}" is not a board member, left unassigned`);
      }
      return {
        title: card.title,
        description: card.description,
        columnId: column.id,
        columnTitle: column.title,
        labels: [...new Set(card.labels.map((l) => l.toLowerCase()))],
        dueDate: card.dueDate,
        assignees,
        checklist: card.checklist,
      };
    });
    return { proposals, warnings };
  }

  // -------------------------------------------------------------------------
  // Streaming: summary and ask (grounded, cited)
  // -------------------------------------------------------------------------

  async stream(
    feature: 'summary' | 'ask',
    userId: string,
    board: BoardRef,
    question: string | undefined,
    clientSignal: AbortSignal,
    emit: (event: AiStreamEvent) => void,
  ): Promise<void> {
    const started = performance.now();
    const { view, memberNames } = await this.loadBoard(board);
    const ctx: BoardContext = buildBoardContext({
      boardTitle: board.title,
      view,
      memberNames,
      question,
    });
    const system = feature === 'summary' ? SUMMARY_SYSTEM : ASK_SYSTEM;
    const prompt = boardPrompt(ctx, question);
    const limits = LIMITS[feature];
    const reservation = await this.deps.budget.reserve(
      userId,
      worstCaseTokens(estimatePromptTokens(system, prompt), limits.maxTokens),
    );

    const total: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let status = 'ok';
    let model = this.deps.provider.model;
    const { signal, didTimeout, cleanup } = this.deadline(clientSignal);
    let text = '';
    let firstToken = true;
    try {
      emit({
        event: 'meta',
        data: { provider: this.deps.provider.name, model, cards: ctx.cards.length },
      });
      for await (const event of this.deps.provider.streamText({
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: limits.maxTokens,
        effort: limits.effort,
        signal,
      })) {
        if (event.type === 'text') {
          if (firstToken) {
            firstToken = false;
            this.deps.metrics.aiFirstToken.observe(
              { feature },
              (performance.now() - started) / 1000,
            );
          }
          text += event.text;
          emit({ event: 'delta', data: { text: event.text } });
          continue;
        }
        total.inputTokens += event.usage.inputTokens;
        total.outputTokens += event.usage.outputTokens;
        model = event.model;
        if (event.stopReason === 'refusal') {
          status = 'refused';
          emit({
            event: 'refusal',
            data: { message: 'The AI declined this request. Discard any partial answer above.' },
          });
          return;
        }
        // Citations are validated against the context we actually sent.
        emit({ event: 'citations', data: resolveCitations(text, ctx) });
        emit({
          event: 'done',
          data: { usage: total, truncated: event.stopReason === 'max_tokens' },
        });
      }
    } catch (err) {
      status = this.statusOf(err, didTimeout());
      if (err instanceof LlmRefusalError) {
        total.inputTokens += err.usage.inputTokens;
        total.outputTokens += err.usage.outputTokens;
      }
      const aiError = this.toAiError(err, didTimeout());
      if (status !== 'client_closed') {
        emit({ event: 'error', data: { code: aiError.code, message: aiError.message } });
      }
    } finally {
      cleanup();
      // Streams are charged even if the client went away mid-way: the
      // provider still generated (and billed) those tokens. When the provider
      // never reported usage (abort), charge an estimate of what we streamed.
      if (total.outputTokens === 0 && text) total.outputTokens = Math.ceil(text.length / 4);
      await this.finish({
        userId,
        board,
        feature,
        reservation,
        total,
        attempts: 1,
        status,
        model,
        started,
      });
    }
  }

  // -------------------------------------------------------------------------

  private async loadBoard(board: BoardRef) {
    // Snapshot + pending update log: lags live edits by milliseconds when the
    // board is quiet, by at most one ~250ms batching window during bursts.
    const doc = await loadBoardDoc(this.deps.db, board.boardId);
    const view = readBoard(doc);
    doc.destroy();
    const members = await this.deps.db
      .select({ userId: users.id, name: users.name })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, board.workspaceId));
    return { view, members, memberNames: new Map(members.map((m) => [m.userId, m.name])) };
  }

  /** Combines the request deadline with the client's disconnect signal. */
  private deadline(clientSignal: AbortSignal) {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('AI request timed out', 'TimeoutError')),
      this.deps.timeoutMs,
    );
    return {
      signal: AbortSignal.any([timeout.signal, clientSignal]),
      didTimeout: () => timeout.signal.aborted,
      cleanup: () => clearTimeout(timer),
    };
  }

  private statusOf(err: unknown, timedOut: boolean): string {
    if (timedOut) return 'timeout';
    if (err instanceof LlmRefusalError) return 'refused';
    if (err instanceof AiError) return err.code;
    if (err instanceof LlmUnavailableError) return 'unavailable';
    if (isAbort(err)) return 'client_closed';
    return 'error';
  }

  private toAiError(err: unknown, timedOut: boolean): AiError {
    if (err instanceof AiError) return err;
    if (timedOut) {
      return new AiError(504, 'ai_timeout', 'The AI took too long to answer. Please try again.');
    }
    if (err instanceof LlmRefusalError) {
      return new AiError(422, 'ai_refused', 'The AI declined this request.');
    }
    if (err instanceof LlmUnavailableError) {
      const status = err.status === 429 ? 503 : 502;
      return new AiError(status, 'ai_unavailable', err.message);
    }
    if (isAbort(err)) return new AiError(499, 'client_closed', 'Request cancelled');
    this.deps.logger.error({ err }, 'unexpected AI error');
    return new AiError(500, 'ai_error', 'Something went wrong talking to the AI');
  }

  private async finish(input: {
    userId: string;
    board: BoardRef;
    feature: AiFeature;
    reservation: Reservation;
    total: LlmUsage;
    attempts: number;
    status: string;
    model: string;
    started: number;
  }) {
    const { feature, total, status } = input;
    const latencyMs = Math.round(performance.now() - input.started);
    const { metrics, logger } = this.deps;
    metrics.aiLatency.observe({ feature, status }, latencyMs / 1000);
    metrics.aiRequests.inc({ feature, status });
    metrics.aiTokens.inc({ feature, direction: 'input' }, total.inputTokens);
    metrics.aiTokens.inc({ feature, direction: 'output' }, total.outputTokens);
    try {
      await this.deps.budget.settle(input.reservation, total.inputTokens + total.outputTokens);
      await this.deps.db.insert(aiRequests).values({
        userId: input.userId,
        boardId: input.board.boardId,
        feature,
        provider: this.deps.provider.name,
        model: input.model,
        status,
        attempts: input.attempts,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        latencyMs,
      });
    } catch (err) {
      logger.error({ err, feature }, 'failed to record AI usage');
    }
    logger.info(
      { feature, status, latencyMs, attempts: input.attempts, model: input.model, ...total },
      'ai request finished',
    );
  }
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
    (typeof DOMException !== 'undefined' && err instanceof DOMException)
  );
}
