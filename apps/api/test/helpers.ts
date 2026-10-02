import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { createDb } from '@huddle/db';
import type { ServerEvent } from '@huddle/shared';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { buildDeps, type AppDeps } from '../src/deps';
import type { EventPublisher } from '../src/events';
import { createLogger } from '../src/logger';

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  events: ServerEvent[];
  config: Config;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-123';

export async function createTestContext(
  overrides: Record<string, string> = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: TEST_JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const handle = createDb(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL);
  const events: ServerEvent[] = [];
  const publisher: EventPublisher = {
    async publish(event) {
      events.push(event);
    },
  };
  const deps = buildDeps({
    config,
    db: handle.db,
    redis,
    logger: createLogger('silent', false),
    events: publisher,
  });
  const app = createApp(deps);

  const reset = async () => {
    const { rows } = await handle.pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    );
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    if (tables) await handle.db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
    await redis.flushdb();
    events.length = 0;
  };

  return {
    app,
    deps,
    events,
    config,
    reset,
    close: async () => {
      await handle.close();
      await redis.quit();
    },
  };
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

/** Extracts `name=value` of a Set-Cookie header. */
export function cookieValue(
  setCookie: string[] | string | undefined,
  name: string,
): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const [k, ...v] = pair!.split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}
