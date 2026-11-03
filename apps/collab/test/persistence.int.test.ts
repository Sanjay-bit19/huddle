import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  boardDocuments,
  boardUpdates,
  compactBoard,
  loadBoardState,
  type DbHandle,
} from '@huddle/db';
import { addCard, readBoard, updateCard } from '@huddle/shared/board';
import {
  connect,
  createFixture,
  resetDb,
  startCollab,
  testDb,
  waitFor,
  type RunningCollab,
  type TestClient,
} from './helpers';

let handle: DbHandle;
let servers: RunningCollab[] = [];
let clients: TestClient[] = [];
const prefix = () => `test-${randomUUID().slice(0, 8)}`;

beforeAll(() => {
  handle = testDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDb(handle);
});
afterEach(async () => {
  clients.forEach((c) => c.destroy());
  clients = [];
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

const track = <T extends TestClient>(c: T) => (clients.push(c), c);
const start = async (p: string) => {
  const s = await startCollab(handle, { prefix: p });
  servers.push(s);
  return s;
};

describe('hydration and persistence', () => {
  it('hydrates a new board from its seed snapshot', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    const server = await start(prefix());
    const client = track(connect(server.url, fx.boardId, editor.token));
    await client.synced;
    expect(readBoard(client.doc).columns.map((c) => c.title)).toEqual([
      'To do',
      'In progress',
      'Done',
    ]);
  });

  it('appends client updates to the log quickly, then compacts them into the snapshot', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    const server = await start(prefix());
    const client = track(connect(server.url, fx.boardId, editor.token));
    await client.synced;
    const col = readBoard(client.doc).columns[0]!.id;

    addCard(client.doc, { columnId: col, title: 'Persist me' }, { userId: editor.userId });

    // Tier 1: the incremental update reaches the log within the flush window.
    await waitFor(
      async () =>
        (await handle.db.select().from(boardUpdates).where(eq(boardUpdates.boardId, fx.boardId)))
          .length > 0,
      { message: 'update log row' },
    );
    const [logged] = await handle.db.select().from(boardUpdates);
    expect(logged!.userId).toBe(editor.userId);

    // Tier 2: debounced compaction folds the log into the snapshot and trims it.
    await waitFor(
      async () => {
        const rows = await handle.db.select().from(boardUpdates);
        const [snap] = await handle.db.select().from(boardDocuments);
        return rows.length === 0 && (snap?.compactedUpdates ?? 0) > 0;
      },
      { message: 'compaction' },
    );
    const { state } = await loadBoardState(handle.db, fx.boardId);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, state!);
    expect(readBoard(restored).cards.map((c) => c.title)).toEqual(['Persist me']);
  });

  it('survives a server restart: a fresh node hydrates snapshot + pending log', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    const p = prefix();
    const first = await start(p);
    const a = connect(first.url, fx.boardId, editor.token);
    await a.synced;
    const col = readBoard(a.doc).columns[0]!.id;
    const id = addCard(a.doc, { columnId: col, title: 'Before restart' });
    updateCard(a.doc, id, { dueDate: '2026-12-24' });
    await waitFor(async () => (await handle.db.select().from(boardUpdates)).length > 0);
    a.destroy();
    await first.stop();
    servers = servers.filter((s) => s !== first);

    const second = await start(p);
    const b = track(connect(second.url, fx.boardId, editor.token, new Y.Doc()));
    await b.synced;
    expect(readBoard(b.doc).cards).toEqual([
      expect.objectContaining({ title: 'Before restart', dueDate: '2026-12-24' }),
    ]);
  });

  it('hydrates from snapshot plus updates that were never compacted', async () => {
    const fx = await createFixture(handle);
    const editor = await fx.member('EDITOR');
    // Simulate a crash between log append and compaction: write log rows directly.
    const doc = new Y.Doc();
    const { state } = await loadBoardState(handle.db, fx.boardId);
    Y.applyUpdate(doc, state!);
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const col = readBoard(doc).columns[1]!.id;
    addCard(doc, { columnId: col, title: 'From the log 1' });
    addCard(doc, { columnId: col, title: 'From the log 2' });
    await handle.db
      .insert(boardUpdates)
      .values(updates.map((update) => ({ boardId: fx.boardId, update, userId: null })));

    const server = await start(prefix());
    const client = track(connect(server.url, fx.boardId, editor.token));
    await client.synced;
    expect(
      readBoard(client.doc)
        .cards.map((c) => c.title)
        .sort(),
    ).toEqual(['From the log 1', 'From the log 2']);
  });

  it('compaction is idempotent and safe when run concurrently', async () => {
    const fx = await createFixture(handle);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await loadBoardState(handle.db, fx.boardId)).state!);
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const col = readBoard(doc).columns[0]!.id;
    for (let i = 0; i < 20; i++) addCard(doc, { columnId: col, title: `c${i}` });
    await handle.db
      .insert(boardUpdates)
      .values(updates.map((update) => ({ boardId: fx.boardId, update, userId: null })));

    await Promise.all([
      compactBoard(handle.db, fx.boardId),
      compactBoard(handle.db, fx.boardId),
      compactBoard(handle.db, fx.boardId, Y.encodeStateAsUpdate(doc)),
    ]);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await loadBoardState(handle.db, fx.boardId)).state!);
    expect(readBoard(restored).cards).toHaveLength(20);
    expect(await handle.db.select().from(boardUpdates)).toHaveLength(0);
  });

  it('compaction garbage-collects deleted content', async () => {
    const fx = await createFixture(handle);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await loadBoardState(handle.db, fx.boardId)).state!);
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const col = readBoard(doc).columns[0]!.id;
    const big = 'lorem ipsum '.repeat(400);
    for (let i = 0; i < 10; i++) {
      const id = addCard(doc, { columnId: col, title: `t${i}`, description: big });
      doc.getMap('cards').delete(id);
    }
    await handle.db
      .insert(boardUpdates)
      .values(updates.map((update) => ({ boardId: fx.boardId, update, userId: null })));
    const logBytes = updates.reduce((n, u) => n + u.byteLength, 0);
    const { snapshotBytes } = await compactBoard(handle.db, fx.boardId);
    // ~48 KB of since-deleted text is reduced to tombstones.
    expect(logBytes).toBeGreaterThan(40_000);
    expect(snapshotBytes).toBeLessThan(2_000);
  });
});
