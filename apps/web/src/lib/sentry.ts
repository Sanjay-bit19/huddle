import * as Sentry from '@sentry/react';
import { authStore } from './api';

/** Optional: only active when VITE_SENTRY_DSN is set at build time. */
export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({ dsn, environment: import.meta.env.MODE, tracesSampleRate: 0 });
  // Attach the user id (never email/name) so errors can be correlated with logs.
  authStore.subscribe(() => {
    const state = authStore.getSnapshot();
    Sentry.setUser(state.status === 'authenticated' ? { id: state.user.id } : null);
  });
}

export { Sentry };
