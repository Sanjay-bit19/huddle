import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Server, type Extension } from '@hocuspocus/server';
import type { Database } from '@huddle/db';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { CollabConfig } from './config';
import { subscribeToControlEvents } from './control-events';
import { activityExtension } from './extensions/activity';
import { authExtension } from './extensions/auth';
import { guardExtension } from './extensions/guard';
import { persistenceExtension } from './extensions/persistence';
import { createCollabMetrics, type CollabMetrics } from './metrics';

export interface CollabServerDeps {
  config: CollabConfig;
  db: Database;
  logger: Logger;
  metrics?: CollabMetrics;
  /** Extra extensions (e.g. activity log), appended after the built-ins. */
  extensions?: Extension[];
}

export interface CollabServer {
  server: Server;
  metrics: CollabMetrics;
  listen(port?: number): Promise<number>;
  stop(): Promise<void>;
}

export function createCollabServer(deps: CollabServerDeps): CollabServer {
  const { config, db, logger } = deps;
  const metrics = deps.metrics ?? createCollabMetrics(config.INSTANCE_ID);
  const activity = activityExtension({ db, logger, metrics });
  const persistence = persistenceExtension({
    db,
    logger,
    metrics,
    flushMs: config.UPDATE_LOG_FLUSH_MS,
  });

  // Redis pub/sub keeps every node's copy of a board converged, so clients of
  // one board can be spread over any number of nodes (no sticky sessions).
  const redisExtension = new RedisExtension({
    createClient: () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    prefix: config.REDIS_PREFIX,
    identifier: config.INSTANCE_ID,
  });

  const httpExtension: Extension = {
    extensionName: 'huddle-http',
    async onRequest({ request, response }) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, instance: config.INSTANCE_ID }));
        throw null; // handled: stop Hocuspocus' default response
      }
      if (url.pathname === '/debug/gc' && config.BENCH_GC_ENDPOINT && request.method === 'POST') {
        const gc = (globalThis as { gc?: () => void }).gc;
        gc?.();
        response.writeHead(gc ? 200 : 501, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(process.memoryUsage()));
        throw null;
      }
      if (url.pathname === '/metrics') {
        const auth = request.headers.authorization;
        if (config.METRICS_TOKEN && auth !== `Bearer ${config.METRICS_TOKEN}`) {
          response.writeHead(401).end();
          throw null;
        }
        response.writeHead(200, { 'Content-Type': metrics.registry.contentType });
        response.end(await metrics.registry.metrics());
        throw null;
      }
    },
  };

  const server = new Server({
    name: config.INSTANCE_ID,
    quiet: true,
    stopOnSignals: false,
    debounce: config.STORE_DEBOUNCE_MS,
    maxDebounce: config.STORE_MAX_DEBOUNCE_MS,
    // Hocuspocus pings every `timeout / ... ` and drops dead sockets.
    timeout: 30_000,
    websocketOptions: { maxPayload: 4 * 1024 * 1024 },
    extensions: [
      httpExtension,
      redisExtension,
      authExtension({ db, jwtSecret: config.JWT_SECRET, logger, metrics }),
      guardExtension({ logger, metrics }),
      persistence,
      activity,
      ...(deps.extensions ?? []),
    ],
  });
  metrics.bind(server.hocuspocus);

  const control = subscribeToControlEvents({
    redisUrl: config.REDIS_URL,
    hocuspocus: server.hocuspocus,
    db,
    logger,
  });

  return {
    server,
    metrics,
    async listen(port = config.PORT) {
      await control.ready;
      await server.listen(port);
      logger.info({ port: server.address.port, instance: config.INSTANCE_ID }, 'collab listening');
      return server.address.port;
    },
    async stop() {
      await server.destroy();
      await Promise.all([persistence.flushAll(), activity.flushAll()]);
      await control.close();
    },
  };
}
