import type { RequestHandler } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { sessions, users, type Database } from '@huddle/db';
import { verifyAccessToken } from '@huddle/shared/server';
import { unauthorized } from './errors';

export interface AuthContext {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Verifies the bearer token's signature and expiry, then confirms its session
 * is still live. The session lookup is a single PK join and is what makes
 * logout / reuse revocation immediate for access tokens.
 */
export function requireAuth(db: Database, jwtSecret: string): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized();

    let claims;
    try {
      claims = await verifyAccessToken(token, jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired access token');
    }

    const [row] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, claims.sid),
          eq(sessions.userId, claims.sub),
          isNull(sessions.revokedAt),
        ),
      );
    if (!row) throw unauthorized('Session has been revoked');

    req.auth = { userId: row.id, sessionId: claims.sid, name: row.name, email: row.email };
    req.log = req.log.child({ userId: row.id });
    next();
  };
}

export function authOf(req: Express.Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * Cookie-authenticated endpoints (refresh, logout) require a custom header.
 * Browsers cannot attach custom headers cross-site without a CORS preflight,
 * which this API never grants, so this blocks CSRF in addition to the
 * SameSite=Strict cookie.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.get('x-requested-with') !== 'huddle') throw unauthorized('Missing CSRF header');
  next();
};
