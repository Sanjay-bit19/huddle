import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { authRouter } from './auth/routes';
import { boardsRouter, workspaceBoardsRouter } from './boards/routes';
import type { AppDeps } from './deps';
import { errorHandler, notFound } from './http/errors';
import { invitesRouter } from './invites/routes';
import { workspacesRouter } from './workspaces/routes';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger: deps.logger,
      // Honor an upstream request id (load balancer) so a request can be
      // traced across hops; otherwise mint one. Echoed back to the client.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter(deps));
  app.use('/api/workspaces/:workspaceId/boards', workspaceBoardsRouter(deps));
  app.use('/api/workspaces', workspacesRouter(deps));
  app.use('/api/invites', invitesRouter(deps));
  app.use('/api/boards', boardsRouter(deps));

  app.use('/api', () => {
    throw notFound('Route not found');
  });
  app.use(errorHandler);
  return app;
}
