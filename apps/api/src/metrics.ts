import type { RequestHandler } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function createApiMetrics() {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'api' });
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const metrics = {
    registry,
    aiLatency: new Histogram({
      name: 'ai_request_duration_seconds',
      help: 'End-to-end AI feature latency (including retries)',
      labelNames: ['feature', 'status'] as const,
      buckets: [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60],
      registers: [registry],
    }),
    aiFirstToken: new Histogram({
      name: 'ai_time_to_first_token_seconds',
      help: 'Latency until the first streamed token',
      labelNames: ['feature'] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 15],
      registers: [registry],
    }),
    aiTokens: new Counter({
      name: 'ai_tokens_total',
      help: 'Tokens consumed by AI features',
      labelNames: ['feature', 'direction'] as const,
      registers: [registry],
    }),
    aiRequests: new Counter({
      name: 'ai_requests_total',
      help: 'AI feature requests by outcome',
      labelNames: ['feature', 'status'] as const,
      registers: [registry],
    }),
    /** Records latency per matched route (not raw URL, to keep cardinality bounded). */
    httpMiddleware: ((req, res, next) => {
      const end = httpDuration.startTimer();
      res.on('finish', () => {
        const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
        end({ method: req.method, route, status: String(res.statusCode) });
      });
      next();
    }) as RequestHandler,
  };
  return metrics;
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;
