import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://huddle:huddle@localhost:5432/huddle'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool.optional(),
  // Number of proxy hops in front of the API (load balancer, Vercel rewrite)
  // so req.ip is the real client IP for rate limiting.
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),
  RATE_LIMIT_DISABLED: bool.default(false),
  APP_URL: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RUN_MIGRATIONS: bool.default(false),
  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  /** Server-side refusal fallback (Claude API only). */
  AI_FALLBACKS: bool.default(true),
  AI_MONTHLY_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Keep the AI limiter on even when RATE_LIMIT_DISABLED is set (tests). */
  AI_RATE_LIMIT_ENFORCED: bool.default(false),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  METRICS_TOKEN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Config = z.infer<typeof configSchema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid API configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (c.AI_PROVIDER === 'anthropic' && !c.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY (or use AI_PROVIDER=mock)');
  }
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}
