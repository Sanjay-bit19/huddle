import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { refreshTokens, sessions, users, type Database, type DbUser } from '@huddle/db';
import type { LoginInput, PublicUser, SignupInput } from '@huddle/shared';
import type { Config } from '../config';
import type { EventPublisher } from '../events';
import type { Logger } from '../logger';
import { conflict, unauthorized } from '../http/errors';
import { generateOpaqueToken, hashToken, signAccessToken } from '@huddle/shared/server';

export interface ClientMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface IssuedTokens {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

// argon2id with OWASP-recommended parameters (19 MiB, 2 iterations).
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const toPublicUser = (u: Pick<DbUser, 'id' | 'email' | 'name'>): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
});

export class AuthService {
  // Verified against when the email is unknown so login timing does not reveal
  // which emails have accounts.
  private dummyHash: Promise<string>;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly events: EventPublisher,
    private readonly logger: Logger,
  ) {
    this.dummyHash = hash('not-a-real-password', ARGON2_OPTIONS);
  }

  async signup(input: SignupInput, meta: ClientMeta): Promise<IssuedTokens> {
    const passwordHash = await hash(input.password, ARGON2_OPTIONS);
    const [user] = await this.db
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (!user) throw conflict('An account with this email already exists');
    return this.startSession(user, meta);
  }

  async login(input: LoginInput, meta: ClientMeta): Promise<IssuedTokens> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, input.email) });
    const ok = await verify(user?.passwordHash ?? (await this.dummyHash), input.password);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    return this.startSession(user, meta);
  }

  /**
   * Rotates a refresh token. The row is locked (FOR UPDATE) so two concurrent
   * refreshes with the same token serialize: the second one sees `used_at`
   * set and is treated as reuse. Browsers avoid tripping this by serializing
   * refreshes across tabs with the Web Locks API (see apps/web/src/lib/api.ts).
   */
  async refresh(rawToken: string, meta: ClientMeta): Promise<IssuedTokens> {
    const tokenHash = hashToken(rawToken);
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ token: refreshTokens, session: sessions, user: users })
        .from(refreshTokens)
        .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .for('update', { of: [refreshTokens, sessions] });

      if (!row) return { kind: 'invalid' as const };
      const { token, session, user } = row;
      if (session.revokedAt) return { kind: 'invalid' as const };

      if (token.usedAt) {
        // Reuse detected: an old token from this chain was presented again.
        // Either the legitimate client or an attacker holds a stolen copy and
        // we cannot tell which, so kill the whole session for both.
        await tx
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'reuse_detected' })
          .where(eq(sessions.id, session.id));
        return { kind: 'reuse' as const, userId: user.id, sessionId: session.id };
      }
      if (token.expiresAt.getTime() <= Date.now()) return { kind: 'invalid' as const };

      const next = generateOpaqueToken();
      const expiresAt = this.refreshExpiry();
      const [inserted] = await tx
        .insert(refreshTokens)
        .values({ sessionId: session.id, tokenHash: hashToken(next), expiresAt })
        .returning({ id: refreshTokens.id });
      await tx
        .update(refreshTokens)
        .set({ usedAt: new Date(), replacedBy: inserted!.id })
        .where(eq(refreshTokens.id, token.id));
      await tx
        .update(sessions)
        .set({
          lastUsedAt: new Date(),
          userAgent: meta.userAgent ?? session.userAgent,
          ip: meta.ip ?? session.ip,
        })
        .where(eq(sessions.id, session.id));
      return { kind: 'ok' as const, user, sessionId: session.id, refreshToken: next, expiresAt };
    });

    if (result.kind === 'reuse') {
      this.logger.warn(
        { userId: result.userId, sessionId: result.sessionId, ip: meta.ip },
        'refresh token reuse detected; session revoked',
      );
      await this.events.publish({
        type: 'sessions-revoked',
        userId: result.userId,
        sessionIds: [result.sessionId],
      });
      throw unauthorized('Session revoked');
    }
    if (result.kind === 'invalid') throw unauthorized('Invalid refresh token');

    return {
      user: toPublicUser(result.user),
      ...(await this.issueAccessToken(result.user, result.sessionId)),
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.expiresAt,
    };
  }

  /** Logs out the session that owns this refresh token. Idempotent. */
  async logout(rawToken: string): Promise<void> {
    const [row] = await this.db
      .select({ sessionId: refreshTokens.sessionId, userId: sessions.userId })
      .from(refreshTokens)
      .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
    if (!row) return;
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)));
    await this.events.publish({
      type: 'sessions-revoked',
      userId: row.userId,
      sessionIds: [row.sessionId],
    });
  }

  /** Revokes every session of the user, on every device. */
  async logoutAll(userId: string): Promise<number> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'logout_all' })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    await this.events.publish({ type: 'sessions-revoked', userId });
    return revoked.length;
  }

  private async startSession(user: DbUser, meta: ClientMeta): Promise<IssuedTokens> {
    const refreshToken = generateOpaqueToken();
    const refreshExpiresAt = this.refreshExpiry();
    const sessionId = await this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({ userId: user.id, userAgent: meta.userAgent, ip: meta.ip })
        .returning({ id: sessions.id });
      await tx.insert(refreshTokens).values({
        sessionId: session!.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      });
      return session!.id;
    });
    return {
      user: toPublicUser(user),
      ...(await this.issueAccessToken(user, sessionId)),
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async issueAccessToken(user: DbUser, sessionId: string) {
    const ttl = this.config.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await signAccessToken(
      { sub: user.id, name: user.name, sid: sessionId },
      this.config.JWT_SECRET,
      ttl,
    );
    return { accessToken, expiresIn: ttl };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  }
}
