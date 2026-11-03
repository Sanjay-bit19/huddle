import * as Sentry from '@sentry/node';

/**
 * Sentry is optional: without SENTRY_DSN nothing is initialized and
 * captureError is a no-op, so local dev and tests never send events.
 */
export function initSentry(dsn: string | undefined, environment: string, service: string): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment,
    initialScope: { tags: { service } },
    // Errors only; tracing is handled by Prometheus metrics + request ids.
    tracesSampleRate: 0,
  });
}

export function captureError(err: unknown, context: Record<string, unknown> = {}): void {
  if (!Sentry.isInitialized()) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    Sentry.captureException(err);
  });
}
