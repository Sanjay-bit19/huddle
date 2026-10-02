import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  generateOpaqueToken,
  hashToken,
  secretKey,
  signAccessToken,
  verifyAccessToken,
} from './tokens';

const SECRET = 'unit-test-secret-unit-test-secret-1234';
const claims = {
  sub: '7f1c6a2e-1d0c-4d61-9d4f-4b1b0a3d2c11',
  name: 'Ada',
  sid: '0b6f8c2e-9a1e-4a8d-8c5e-0f1e2d3c4b5a',
};

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const token = await signAccessToken(claims, SECRET, 60);
    await expect(verifyAccessToken(token, SECRET)).resolves.toEqual(claims);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signAccessToken(claims, 'another-secret-another-secret-12345', 60);
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken(claims, SECRET, 60);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: crypto.randomUUID() })).toString(
      'base64url',
    );
    await expect(verifyAccessToken(`${h}.${forged}.${s}`, SECRET)).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const token = await new SignJWT({ name: claims.name, sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('huddle')
      .setAudience('huddle')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secretKey(SECRET));
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects the "none" algorithm', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ ...claims, iss: 'huddle', aud: 'huddle', exp: Date.now() / 1000 + 60 }),
    ).toString('base64url');
    await expect(verifyAccessToken(`${header}.${payload}.`, SECRET)).rejects.toThrow();
  });

  it('rejects tokens missing the session claim', async () => {
    const token = await new SignJWT({ name: claims.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('huddle')
      .setAudience('huddle')
      .setExpirationTime('1m')
      .sign(secretKey(SECRET));
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow();
  });
});

describe('opaque tokens', () => {
  it('are unique, url-safe and 256-bit', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash deterministically and never equal the raw token', () => {
    const t = generateOpaqueToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toHaveLength(64);
  });
});
