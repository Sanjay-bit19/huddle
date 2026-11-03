import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { sessions } from '@huddle/db';
import { REFRESH_COOKIE } from '../src/auth/routes';
import { cookieValue, createTestContext, uniqueEmail, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

const CSRF = { 'X-Requested-With': 'huddle' };

async function signup(email = uniqueEmail(), password = 'correct horse battery') {
  const res = await request(ctx.app)
    .post('/api/auth/signup')
    .send({ email, name: 'Ada', password })
    .expect(201);
  const refresh = cookieValue(res.headers['set-cookie'], REFRESH_COOKIE)!;
  return { email, password, accessToken: res.body.accessToken as string, refresh, res };
}

const refreshWith = (token: string) =>
  request(ctx.app).post('/api/auth/refresh').set(CSRF).set('Cookie', `${REFRESH_COOKIE}=${token}`);

const me = (accessToken: string) =>
  request(ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

describe('signup and login', () => {
  it('issues an access token and a hardened refresh cookie', async () => {
    const { res, accessToken } = await signup();
    expect(res.body.user).toMatchObject({ name: 'Ada' });
    expect(accessToken.split('.')).toHaveLength(3);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${REFRESH_COOKIE}=`),
    )!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    await me(accessToken).expect(200);
  });

  it('normalizes email and rejects duplicates', async () => {
    const email = uniqueEmail();
    await signup(email);
    await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: `  ${email.toUpperCase()} `, name: 'Ada 2', password: 'another password' })
      .expect(409);
  });

  it('validates input', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'nope', name: '', password: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects bad credentials with a generic message', async () => {
    const { email } = await signup();
    const wrongPw = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong password' })
      .expect(401);
    const noUser = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('ghost'), password: 'wrong password' })
      .expect(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);
  });

  it('logs in with valid credentials', async () => {
    const { email, password } = await signup();
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    await me(res.body.accessToken).expect(200);
  });

  it('requires a bearer token on protected routes', async () => {
    await request(ctx.app).get('/api/auth/me').expect(401);
    await me('not-a-jwt').expect(401);
  });
});

describe('refresh token rotation', () => {
  it('rotates: each refresh returns a new refresh token and access token', async () => {
    const { refresh } = await signup();
    const r1 = await refreshWith(refresh).expect(200);
    const next = cookieValue(r1.headers['set-cookie'], REFRESH_COOKIE)!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(refresh);
    await me(r1.body.accessToken).expect(200);

    const r2 = await refreshWith(next).expect(200);
    expect(cookieValue(r2.headers['set-cookie'], REFRESH_COOKIE)).not.toBe(next);
  });

  it('detects reuse of a rotated token and revokes the whole session', async () => {
    const { refresh, accessToken } = await signup();
    // Legitimate client rotates.
    const r1 = await refreshWith(refresh).expect(200);
    const legit = cookieValue(r1.headers['set-cookie'], REFRESH_COOKIE)!;

    // Attacker replays the stolen, already-used token.
    const replay = await refreshWith(refresh).expect(401);
    expect(replay.body.error.message).toBe('Session revoked');

    // The whole chain is dead: the legitimate successor no longer works...
    await refreshWith(legit).expect(401);
    // ...and neither do access tokens minted for that session.
    await me(accessToken).expect(401);
    await me(r1.body.accessToken).expect(401);

    const [session] = await ctx.deps.db.select().from(sessions);
    expect(session!.revokedReason).toBe('reuse_detected');
    // Collab servers are told to drop this session's sockets.
    expect(ctx.events).toContainEqual({
      type: 'sessions-revoked',
      userId: session!.userId,
      sessionIds: [session!.id],
    });
  });

  it('treats concurrent refreshes with the same token as reuse (serialized by row lock)', async () => {
    const { refresh } = await signup();
    const results = await Promise.all([refreshWith(refresh), refreshWith(refresh)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
    const [session] = await ctx.deps.db.select().from(sessions);
    expect(session!.revokedReason).toBe('reuse_detected');
  });

  it('requires the CSRF header', async () => {
    const { refresh } = await signup();
    await request(ctx.app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`)
      .expect(401);
    // The token was not consumed by the rejected request.
    await refreshWith(refresh).expect(200);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    await refreshWith('garbage').expect(401);
    const { refresh } = await signup();
    await ctx.deps.db.execute(
      sql`update refresh_tokens set expires_at = now() - interval '1 second'`,
    );
    await refreshWith(refresh).expect(401);
  });
});

describe('logout', () => {
  it('logout revokes the session and its access tokens', async () => {
    const { refresh, accessToken } = await signup();
    await request(ctx.app)
      .post('/api/auth/logout')
      .set(CSRF)
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`)
      .expect(204);
    await refreshWith(refresh).expect(401);
    await me(accessToken).expect(401);
  });

  it('logout everywhere revokes every session of the user only', async () => {
    const a = await signup();
    const laptop = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: a.email, password: a.password })
      .expect(200);
    const laptopRefresh = cookieValue(laptop.headers['set-cookie'], REFRESH_COOKIE)!;
    const other = await signup();

    const res = await request(ctx.app)
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(res.body.revokedSessions).toBe(2);

    await me(a.accessToken).expect(401);
    await me(laptop.body.accessToken).expect(401);
    await refreshWith(a.refresh).expect(401);
    await refreshWith(laptopRefresh).expect(401);
    // Another user is unaffected.
    await me(other.accessToken).expect(200);

    const userId = a.res.body.user.id;
    const live = await ctx.deps.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(live.every((s) => s.revokedReason === 'logout_all')).toBe(true);
    expect(ctx.events).toContainEqual({ type: 'sessions-revoked', userId });
  });

  it('lists active sessions and marks the current one', async () => {
    const a = await signup();
    await request(ctx.app).post('/api/auth/login').send({ email: a.email, password: a.password });
    const res = await request(ctx.app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
  });
});

describe('rate limiting', () => {
  it('limits repeated login attempts per ip+email', async () => {
    const { email } = await signup();
    for (let i = 0; i < 10; i++) {
      await request(ctx.app)
        .post('/api/auth/login')
        .send({ email, password: 'wrong password' })
        .expect(401);
    }
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong password' })
      .expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.error.code).toBe('rate_limited');
  });
});
