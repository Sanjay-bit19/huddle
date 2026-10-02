import { authResponseSchema, type AuthResponse, type PublicUser } from '@huddle/shared';

/**
 * Auth model on the client:
 * - The access token lives only in memory (never localStorage), so an XSS
 *   payload cannot exfiltrate a long-lived credential from storage.
 * - The refresh token is an httpOnly cookie scoped to /api/auth.
 * - Refreshes are single-flight within a tab and serialized across tabs with
 *   the Web Locks API. Two tabs refreshing with the same cookie at once would
 *   otherwise trip the server's reuse detection and log the user out.
 */

export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'authenticated'; user: PublicUser };

let state: AuthState = { status: 'loading', user: null };
let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshInFlight: Promise<string | null> | null = null;
const listeners = new Set<() => void>();
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('huddle-auth') : null;

channel?.addEventListener('message', (e: MessageEvent<{ type: string }>) => {
  // Another tab logged out: the shared cookie is gone, so drop our token too.
  if (e.data?.type === 'logout') setSession(null, false);
});

function emit() {
  for (const l of listeners) l();
}

export const authStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => state,
};

export function setSession(session: AuthResponse | null, broadcast = true) {
  if (session) {
    accessToken = session.accessToken;
    // Refresh slightly early so in-flight requests never race expiry.
    accessTokenExpiresAt = Date.now() + (session.expiresIn - 30) * 1000;
    state = { status: 'authenticated', user: session.user };
  } else {
    const wasAuthed = state.status === 'authenticated';
    accessToken = null;
    accessTokenExpiresAt = 0;
    state = { status: 'anonymous', user: null };
    if (broadcast && wasAuthed) channel?.postMessage({ type: 'logout' });
  }
  emit();
}

async function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('huddle-auth-refresh', fn);
  }
  return fn();
}

/** Exchanges the refresh cookie for a new access token. Returns null when logged out. */
export function refreshSession(): Promise<string | null> {
  refreshInFlight ??= withCrossTabLock(async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'huddle' },
      });
      if (!res.ok) {
        // 401 = no/invalid session. Anything else (5xx, offline) keeps the
        // current state so a transient outage does not log the user out.
        if (res.status === 401) setSession(null);
        return res.status === 401 ? null : accessToken;
      }
      const body = authResponseSchema.parse(await res.json());
      setSession(body);
      return body.accessToken;
    } catch {
      // Network failure: leave the session as-is and let callers retry.
      if (state.status === 'loading') state = { status: 'anonymous', user: null };
      emit();
      return accessToken;
    }
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** A valid access token, refreshing first if it is about to expire. */
export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  return refreshSession();
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the bearer token (login/signup). */
  anonymous?: boolean;
}

async function rawRequest(
  path: string,
  opts: RequestOptions,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { 'X-Requested-With': 'huddle' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token && !opts.anonymous) headers.Authorization = `Bearer ${token}`;
  return fetch(path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
    signal: opts.signal,
  });
}

export async function apiResponse(path: string, opts: RequestOptions = {}): Promise<Response> {
  const token = opts.anonymous ? null : await getAccessToken();
  let res = await rawRequest(path, opts, token);
  if (res.status === 401 && !opts.anonymous) {
    // The token may have been revoked or expired early (clock skew): one retry.
    const fresh = await refreshSession();
    if (fresh) res = await rawRequest(path, opts, fresh);
  }
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string } } | undefined;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `Request failed (${res.status})`,
      body,
    );
  }
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiResponse(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function login(email: string, password: string) {
  const body = await api<unknown>('/api/auth/login', {
    body: { email, password },
    anonymous: true,
  });
  setSession(authResponseSchema.parse(body));
}

export async function signup(name: string, email: string, password: string) {
  const body = await api<unknown>('/api/auth/signup', {
    body: { name, email, password },
    anonymous: true,
  });
  setSession(authResponseSchema.parse(body));
}

export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', anonymous: true });
  } finally {
    setSession(null);
  }
}

export async function logoutEverywhere() {
  try {
    await api('/api/auth/logout-all', { method: 'POST' });
  } finally {
    setSession(null);
  }
}
