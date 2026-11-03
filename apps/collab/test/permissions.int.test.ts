import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boardUpdates, sessions, workspaceMembers, type DbHandle } from '@huddle/db';
import { SERVER_EVENTS_CHANNEL, type ServerEvent } from '@huddle/shared';
import { addCard, boardRoots, readBoard } from '@huddle/shared/board';
import { signAccessToken } from '@huddle/shared/server';
import {
  JWT_SECRET,
  connect,
  createFixture,
  resetDb,
  sleep,
  startCollab,
  testDb,
  waitFor,
  type RunningCollab,
  type TestClient,
} from './helpers';

let handle: DbHandle;
let server: RunningCollab;
let redis: Redis;
let clients: TestClient[] = [];

beforeAll(() => {
  handle = testDb();
  redis = new Redis(process.env.REDIS_URL!);
});
afterAll(async () => {
  await handle.close();
  await redis.quit();
});
beforeEach(async () => {
  await resetDb(handle);
  server = await startCollab(handle, { prefix: `perm-${randomUUID().slice(0, 8)}` });
});
afterEach(async () => {
  clients.forEach((c) => c.destroy());
  clients = [];
  await server.stop();
});

const track = (c: TestClient) => (clients.push(c), c);
const publish = (event: ServerEvent) => redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(event));

async function metric(name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith(name))
    .join('\n');
}

describe('authentication', () => {
  it('rejects a bad token', async () => {
    const fx = await createFixture(handle);
    const c = track(connect(server.url, fx.boardId, 'not-a-jwt'));
    expect(await c.authFailure).toBe('unauthorized');
  });

  it('rejects users who are not members of the board workspace', async () => {
    const fx = await createFixture(handle);
    const other = await createFixture(handle);
    const outsider = await other.member('ADMIN', 'outsider');
    const c = track(connect(server.url, fx.boardId, outsider.token));
    expect(await c.authFailure).toBe('forbidden');
  });

  it('rejects tokens whose session was revoked (logout applies to sockets too)', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    await handle.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(eq(sessions.id, editor.sessionId));
    const c = track(connect(server.url, fx.boardId, editor.token));
    expect(await c.authFailure).toBe('session-revoked');
  });

  it('rejects expired tokens', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    const expired = await signAccessToken(
      { sub: editor.userId, name: 'x', sid: editor.sessionId },
      JWT_SECRET,
      1,
    );
    await sleep(1100);
    const c = track(connect(server.url, fx.boardId, expired));
    expect(await c.authFailure).toBe('unauthorized');
  });
});

describe('viewer writes are rejected server-side', () => {
  it('a viewer receives updates but its writes never reach the document', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    const viewer = await fx.member('VIEWER');
    const e = track(connect(server.url, fx.boardId, editor.token));
    const v = track(connect(server.url, fx.boardId, viewer.token));
    await Promise.all([e.synced, v.synced]);
    const col = readBoard(e.doc).columns[0]!.id;

    // Reads: the viewer sees the editor's change live.
    addCard(e.doc, { columnId: col, title: 'from editor' });
    await waitFor(() => readBoard(v.doc).cards.length === 1, { message: 'viewer receives update' });

    // Writes: the viewer's provider sends an update (a modified client could
    // send anything), and the server refuses it.
    addCard(v.doc, { columnId: col, title: 'from viewer' });
    await waitFor(
      async () => (await metric('collab_rejected_writes_total')).includes('read_only'),
      {
        message: 'rejection metric',
      },
    );
    await sleep(300);

    expect(readBoard(e.doc).cards.map((c) => c.title)).toEqual(['from editor']);
    const rows = await handle.db.select().from(boardUpdates);
    expect(rows.every((r) => r.userId !== viewer.userId)).toBe(true);
    // A brand-new client sees only the editor's card.
    const fresh = track(connect(server.url, fx.boardId, editor.token, new Y.Doc()));
    await fresh.synced;
    expect(readBoard(fresh.doc).cards.map((c) => c.title)).toEqual(['from editor']);
  });

  it('the server tells a viewer its scope is read-only', async () => {
    const fx = await createFixture(handle);
    const viewer = await fx.member('VIEWER');
    const v = track(connect(server.url, fx.boardId, viewer.token));
    await v.synced;
    expect(v.provider.authorizedScope).toBe('readonly');
  });
});

describe('update validation', () => {
  it('closes the connection on a malformed write and does not apply it', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    const other = track(connect(server.url, fx.boardId, editor.token));
    const evil = track(connect(server.url, fx.boardId, editor.token, new Y.Doc()));
    await Promise.all([other.synced, evil.synced]);

    evil.doc.transact(() => {
      const card = new Y.Map<unknown>();
      boardRoots(evil.doc).cards.set('evil', card);
      card.set('title', 'x'.repeat(5000));
    });
    expect(await evil.closed).toBe('invalid-update');
    await sleep(200);
    expect(boardRoots(other.doc).cards.has('evil')).toBe(false);
    expect(await metric('collab_rejected_writes_total')).toContain('reason="invalid"');
  });
});

describe('live permission changes (control events via Redis)', () => {
  it('a demoted editor becomes read-only on the open socket', async () => {
    const fx = await createFixture(handle);
    const bob = await fx.member('EDITOR', 'bob');
    const ada = await fx.member('EDITOR', 'ada');
    const b = track(connect(server.url, fx.boardId, bob.token));
    const a = track(connect(server.url, fx.boardId, ada.token));
    await Promise.all([a.synced, b.synced]);
    const col = readBoard(b.doc).columns[0]!.id;

    addCard(b.doc, { columnId: col, title: 'while editor' });
    await waitFor(() => readBoard(a.doc).cards.length === 1);

    await handle.db
      .update(workspaceMembers)
      .set({ role: 'VIEWER' })
      .where(
        and(
          eq(workspaceMembers.userId, bob.userId),
          eq(workspaceMembers.workspaceId, fx.workspaceId),
        ),
      );
    await publish({ type: 'membership-changed', workspaceId: fx.workspaceId, userId: bob.userId });
    await waitFor(() => b.statelessMessages.some((m) => m.includes('role-changed')), {
      message: 'role-changed notice',
    });
    expect(JSON.parse(b.statelessMessages.at(-1)!)).toEqual({
      kind: 'role-changed',
      role: 'VIEWER',
    });

    addCard(b.doc, { columnId: col, title: 'after demotion' });
    await sleep(400);
    expect(readBoard(a.doc).cards.map((c) => c.title)).toEqual(['while editor']);
  });

  it('a removed member is disconnected', async () => {
    const fx = await createFixture(handle);
    const bob = await fx.member('EDITOR', 'bob');
    const b = track(connect(server.url, fx.boardId, bob.token));
    await b.synced;
    await handle.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, bob.userId));
    await publish({ type: 'membership-changed', workspaceId: fx.workspaceId, userId: bob.userId });
    expect(await b.closed).toBe('access-revoked');
  });

  it('logging out everywhere closes that user’s sockets only', async () => {
    const fx = await createFixture(handle);
    const bob = await fx.member('EDITOR', 'bob');
    const ada = await fx.member('EDITOR', 'ada');
    const b = track(connect(server.url, fx.boardId, bob.token));
    const a = track(connect(server.url, fx.boardId, ada.token));
    await Promise.all([a.synced, b.synced]);
    await publish({ type: 'sessions-revoked', userId: bob.userId });
    expect(await b.closed).toBe('session-revoked');
    await sleep(200);
    expect(server.server.hocuspocus.getConnectionsCount()).toBe(1);
  });

  it('deleting a board disconnects everyone on it', async () => {
    const fx = await createFixture(handle);
    const bob = await fx.member('EDITOR', 'bob');
    const b = track(connect(server.url, fx.boardId, bob.token));
    await b.synced;
    await publish({ type: 'board-deleted', boardId: fx.boardId });
    expect(await b.closed).toBe('board-deleted');
  });
});

describe('awareness is server-stamped', () => {
  it('a client cannot impersonate another user in presence', async () => {
    const fx = await createFixture(handle);
    const mallory = await fx.member('EDITOR', 'mallory');
    const ada = await fx.member('EDITOR', 'ada');
    const m = track(connect(server.url, fx.boardId, mallory.token));
    const a = track(connect(server.url, fx.boardId, ada.token));
    await Promise.all([m.synced, a.synced]);

    m.provider.awareness!.setLocalState({
      user: { id: ada.userId, name: 'ada', color: '#000' },
      editingCardId: 'x',
    });
    await waitFor(() =>
      [...a.provider.awareness!.getStates().values()].some((s) => s.editingCardId === 'x'),
    );
    const seen = [...a.provider.awareness!.getStates().values()].find(
      (s) => s.editingCardId === 'x',
    )!;
    expect(seen.user).toMatchObject({ id: mallory.userId, name: 'mallory' });
  });
});
