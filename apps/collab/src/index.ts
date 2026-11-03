import { pino } from 'pino';
import { createDb } from '@huddle/db';
import { loadCollabConfig } from './config';
import { initSentry } from './observability';
import { createCollabServer } from './server';

const config = loadCollabConfig();
initSentry(config.SENTRY_DSN || undefined, config.NODE_ENV, 'collab');
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'collab', instance: config.INSTANCE_ID },
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
const dbHandle = createDb(config.DATABASE_URL);
const collab = createCollabServer({ config, db: dbHandle.db, logger });

await collab.listen();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down: flushing documents');
  await collab.stop();
  await dbHandle.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
