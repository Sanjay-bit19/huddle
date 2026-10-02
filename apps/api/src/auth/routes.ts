import { Router, type CookieOptions, type Request, type Response } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { sessions } from '@huddle/db';
import { loginSchema, signupSchema, type AuthResponse } from '@huddle/shared';
import type { AppDeps } from '../deps';
import { authOf, requireCsrfHeader } from '../http/auth-middleware';
import { unauthorized } from '../http/errors';
import { createRateLimiter } from '../http/rate-limit';
import { parse } from '../http/validate';
import type { ClientMeta, IssuedTokens } from './service';

export const REFRESH_COOKIE = 'huddle_rt';
// Scoped so the refresh token is only ever sent to the auth endpoints.
const REFRESH_COOKIE_PATH = '/api/auth';

export function authRouter(deps: AppDeps): Router {
  const { auth, config, redis, requireAuth } = deps;
  const router = Router();
  const disabled = config.RATE_LIMIT_DISABLED;

  const cookieOptions = (expires?: Date): CookieOptions => ({
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    ...(expires ? { expires } : {}),
  });

  const meta = (req: Request): ClientMeta => ({ userAgent: req.get('user-agent'), ip: req.ip });

  const respond = (res: Response, tokens: IssuedTokens, status = 200) => {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshExpiresAt));
    const body: AuthResponse = {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      user: tokens.user,
    };
    res.status(status).json(body);
  };

  // Login is keyed by IP *and* email: slows credential stuffing against one
  // account without letting one noisy NAT lock out everyone behind it.
  const loginLimiter = createRateLimiter(
    redis,
    {
      keyPrefix: 'login',
      points: 10,
      durationSeconds: 15 * 60,
      key: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
      message: 'Too many login attempts. Try again later.',
    },
    disabled,
  );
  const signupLimiter = createRateLimiter(
    redis,
    {
      keyPrefix: 'signup',
      points: 10,
      durationSeconds: 60 * 60,
      key: (req) => req.ip ?? 'unknown',
    },
    disabled,
  );
  const refreshLimiter = createRateLimiter(
    redis,
    { keyPrefix: 'refresh', points: 60, durationSeconds: 60, key: (req) => req.ip ?? 'unknown' },
    disabled,
  );

  router.post('/signup', signupLimiter, async (req, res) => {
    const input = parse(signupSchema, req.body);
    respond(res, await auth.signup(input, meta(req)), 201);
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const input = parse(loginSchema, req.body);
    respond(res, await auth.login(input, meta(req)));
  });

  router.post('/refresh', requireCsrfHeader, refreshLimiter, async (req, res) => {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || !token) throw unauthorized('No refresh token');
    try {
      respond(res, await auth.refresh(token, meta(req)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw err;
    }
  });

  router.post('/logout', requireCsrfHeader, async (req, res) => {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token) await auth.logout(token);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });

  router.post('/logout-all', requireAuth, async (req, res) => {
    const revoked = await auth.logoutAll(authOf(req).userId);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.json({ revokedSessions: revoked });
  });

  router.get('/me', requireAuth, (req, res) => {
    const { userId, name, email } = authOf(req);
    res.json({ user: { id: userId, name, email } });
  });

  router.get('/sessions', requireAuth, async (req, res) => {
    const { userId, sessionId } = authOf(req);
    const rows = await deps.db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastUsedAt));
    res.json({ sessions: rows.map((s) => ({ ...s, current: s.id === sessionId })) });
  });

  return router;
}
