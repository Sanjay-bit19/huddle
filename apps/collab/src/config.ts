import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(1234),
  DATABASE_URL: z.string().default('postgres://huddle:huddle@localhost:5432/huddle'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Identifies this node in logs, metrics and Redis messages. */
  INSTANCE_ID: z.string().default(() => `collab-${randomUUID().slice(0, 8)}`),
  /** Hocuspocus Redis channel prefix; tests use a unique one for isolation. */
  REDIS_PREFIX: z.string().default('huddle:collab'),
  /** Debounce / max wait before compacting a document into its snapshot. */
  STORE_DEBOUNCE_MS: z.coerce.number().int().positive().default(2000),
  STORE_MAX_DEBOUNCE_MS: z.coerce.number().int().positive().default(10_000),
  /** How long incremental updates are buffered before hitting the update log. */
  UPDATE_LOG_FLUSH_MS: z.coerce.number().int().nonnegative().default(250),
  METRICS_TOKEN: z.string().optional(),
  /**
   * Load-testing only: exposes POST /debug/gc (needs node --expose-gc) so a
   * benchmark can measure heap after a full GC. Never enable in production.
   */
  BENCH_GC_ENDPOINT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SENTRY_DSN: z.string().optional(),
});

export type CollabConfig = z.infer<typeof configSchema>;

export function loadCollabConfig(env: NodeJS.ProcessEnv = process.env): CollabConfig {
  // On Fly.io the machine id is a stable, meaningful instance id.
  const parsed = configSchema.safeParse({ INSTANCE_ID: env.FLY_MACHINE_ID, ...env });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid collab configuration:\n${issues}`);
  }
  return parsed.data;
}
