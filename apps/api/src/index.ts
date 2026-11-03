import { Redis } from 'ioredis';
import { createDb, runMigrations } from '@huddle/db';
import { createApp } from './app';
import { loadConfig } from './config';
import { buildDeps } from './deps';
import { redisEventPublisher } from './events';
import { createLogger } from './logger';
import { initSentry } from './observability';

const config = loadConfig();
initSentry(config.SENTRY_DSN || undefined, config.NODE_ENV, 'api');
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
const dbHandle = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on('error', (err) => logger.error({ err }, 'redis error'));

if (config.RUN_MIGRATIONS) {
  await runMigrations(dbHandle.db);
  logger.info('migrations applied');
}

const deps = buildDeps({
  config,
  db: dbHandle.db,
  redis,
  logger,
  events: redisEventPublisher(redis),
});
const app = createApp(deps);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'api listening');
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([dbHandle.close(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
