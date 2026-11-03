import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

export interface RateLimitOptions {
  keyPrefix: string;
  points: number;
  durationSeconds: number;
  key: (req: Request) => string;
  message?: string;
}

/**
 * Redis-backed so limits hold across every API instance. If Redis is
 * unavailable we fall back to a per-process memory limiter rather than failing
 * open (no limit) or failing closed (outage).
 */
export function createRateLimiter(redis: Redis, opts: RateLimitOptions, disabled = false) {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rl:${opts.keyPrefix}`,
    points: opts.points,
    duration: opts.durationSeconds,
    insuranceLimiter: new RateLimiterMemory({
      points: opts.points,
      duration: opts.durationSeconds,
    }),
  });

  const middleware: RequestHandler = async (req, res, next) => {
    if (disabled) return next();
    try {
      const r = await limiter.consume(opts.key(req));
      res.setHeader('RateLimit-Remaining', String(r.remainingPoints));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: {
            code: 'rate_limited',
            message: opts.message ?? 'Too many requests, slow down.',
            retryAfterSeconds: retryAfter,
          },
        });
        return;
      }
      next(err);
    }
  };
  return Object.assign(middleware, { limiter });
}
