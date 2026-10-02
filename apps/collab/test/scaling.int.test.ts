import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boardUpdates, type DbHandle } from '@huddle/db';
import { SERVER_EVENTS_CHANNEL } from '@huddle/shared';
import { addCard, moveCard, readBoard, toggleLabel, updateCard } from '@huddle/shared/board';
import {
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

/**
 * Horizontal scaling: two collab nodes share nothing but Redis (pub/sub) and
 * Postgres. Clients of the same board are deliberately put on different
 * nodes, as a round-robin load balancer without sticky sessions would.
 */
let handle: DbHandle;
let nodes: RunningCollab[] = [];
let clients: TestClient[] = [];

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
  await Promise.all(nodes.map((n) => n.stop()));
  nodes = [];
});

async function twoNodes(env?: Record<string, string>) {
  const prefix = `scale-${randomUUID().slice(0, 8)}`;
  const a = await startCollab(handle, { prefix, instanceId: 'node-a', env });
  const b = await startCollab(handle, { prefix, instanceId: 'node-b', env });
  nodes.push(a, b);
  return [a, b] as const;
}
const track = (c: TestClient) => (clients.push(c), c);
/**
 * Converged = same state vector (each replica has every operation) and the
 * same rendered board. Y.Map iteration order is per replica, so compare the
 * per-column sorted view, not raw iteration order.
 */
const snapshot = (d: Y.Doc) => {
  const view = readBoard(d);
  return JSON.stringify(
    view.columns.map((col) => [
      col.id,
      view.cardsByColumn.get(col.id)!.map((c) => [c.id, c.title, c.labels]),
    ]),
  );
};
const sameState = (x: Y.Doc, y: Y.Doc) =>
  Buffer.from(Y.encodeStateVector(x)).equals(Buffer.from(Y.encodeStateVector(y))) &&
  snapshot(x) === snapshot(y);

describe('cross-instance sync via Redis', () => {
  it('two clients on different nodes see each other’s edits', async () => {
    const [nodeA, nodeB] = await twoNodes();
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const bob = await fx.member('EDITOR', 'bob');
    const onA = track(connect(nodeA.url, fx.boardId, ada.token));
    const onB = track(connect(nodeB.url, fx.boardId, bob.token));
    await Promise.all([onA.synced, onB.synced]);
    // Each node really holds its own copy of the document.
    expect(nodeA.server.hocuspocus.getConnectionsCount()).toBe(1);
    expect(nodeB.server.hocuspocus.getConnectionsCount()).toBe(1);

    const [todo, doing] = readBoard(onA.doc).columns;
    const started = performance.now();
    const id = addCard(onA.doc, { columnId: todo!.id, title: 'written on node A' });
    await waitFor(() => readBoard(onB.doc).cards.length === 1, { message: 'A -> B' });
    const aToB = performance.now() - started;

    moveCard(onB.doc, id, doing!.id, 0);
    updateCard(onB.doc, id, { title: 'edited on node B' });
    await waitFor(() => readBoard(onA.doc).cards[0]?.title === 'edited on node B', {
      message: 'B -> A',
    });
    expect(readBoard(onA.doc).cards[0]!.columnId).toBe(doing!.id);
    expect(aToB).toBeLessThan(2000);
  });

  it('concurrent bursts from both nodes converge to identical documents', async () => {
    const [nodeA, nodeB] = await twoNodes();
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const bob = await fx.member('EDITOR', 'bob');
    const onA = track(connect(nodeA.url, fx.boardId, ada.token));
    const onB = track(connect(nodeB.url, fx.boardId, bob.token));
    await Promise.all([onA.synced, onB.synced]);
    const cols = readBoard(onA.doc).columns.map((c) => c.id);

    const burst = async (doc: Y.Doc, who: string) => {
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        ids.push(addCard(doc, { columnId: cols[i % 3]!, title: `${who}-${i}`, index: 0 }));
        if (i % 3 === 0 && ids.length > 1) {
          moveCard(doc, ids[i - 1]!, cols[(i + 1) % 3]!, 0);
        }
        if (i % 5 === 0) toggleLabel(doc, ids[0]!, `l${i}`);
        if (i % 7 === 0) await sleep(5);
      }
    };
    await Promise.all([burst(onA.doc, 'a'), burst(onB.doc, 'b')]);
    await waitFor(
      () => readBoard(onA.doc).cards.length === 80 && readBoard(onB.doc).cards.length === 80,
      { message: 'all 80 cards on both sides', timeout: 10_000 },
    );
    await waitFor(() => sameState(onA.doc, onB.doc), { message: 'identical state' });
  });

  it('a late joiner on another node gets unpersisted state from its peer via Redis', async () => {
    // Nothing reaches Postgres during this test: the only way node B can know
    // about the card is Redis' initial state exchange with node A.
    const [nodeA, nodeB] = await twoNodes({
      UPDATE_LOG_FLUSH_MS: '60000',
      STORE_DEBOUNCE_MS: '60000',
      STORE_MAX_DEBOUNCE_MS: '60000',
    });
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const bob = await fx.member('EDITOR', 'bob');
    const onA = track(connect(nodeA.url, fx.boardId, ada.token));
    await onA.synced;
    addCard(onA.doc, { columnId: readBoard(onA.doc).columns[0]!.id, title: 'in memory only' });
    await sleep(100);
    expect(await handle.db.select().from(boardUpdates)).toHaveLength(0);

    const onB = track(connect(nodeB.url, fx.boardId, bob.token));
    await onB.synced;
    await waitFor(() => readBoard(onB.doc).cards[0]?.title === 'in memory only', {
      message: 'late joiner sees peer state',
    });
  });

  it('each update is written to the log exactly once, by the node that received it', async () => {
    const [nodeA, nodeB] = await twoNodes({
      UPDATE_LOG_FLUSH_MS: '10',
      STORE_DEBOUNCE_MS: '60000',
      STORE_MAX_DEBOUNCE_MS: '60000',
    });
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const bob = await fx.member('EDITOR', 'bob');
    const onA = track(connect(nodeA.url, fx.boardId, ada.token));
    const onB = track(connect(nodeB.url, fx.boardId, bob.token));
    await Promise.all([onA.synced, onB.synced]);
    const col = readBoard(onA.doc).columns[0]!.id;

    addCard(onA.doc, { columnId: col, title: 'one' });
    await waitFor(() => readBoard(onB.doc).cards.length === 1);
    addCard(onB.doc, { columnId: col, title: 'two' });
    await waitFor(() => readBoard(onA.doc).cards.length === 2);
    await sleep(300);

    const rows = await handle.db.select().from(boardUpdates);
    expect(rows.filter((r) => r.userId === ada.userId)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === bob.userId)).toHaveLength(1);
    // Relayed copies (Redis origin) are never logged.
    expect(rows).toHaveLength(2);
  });

  it('presence (awareness) crosses nodes too', async () => {
    const [nodeA, nodeB] = await twoNodes();
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const bob = await fx.member('EDITOR', 'bob');
    const onA = track(connect(nodeA.url, fx.boardId, ada.token));
    const onB = track(connect(nodeB.url, fx.boardId, bob.token));
    await Promise.all([onA.synced, onB.synced]);
    onA.provider.awareness!.setLocalStateField('user', {
      id: ada.userId,
      name: 'ada',
      color: '#f00',
    });
    onA.provider.awareness!.setLocalStateField('editingCardId', 'card-123');
    await waitFor(
      () =>
        [...onB.provider.awareness!.getStates().values()].some(
          (s) => s.editingCardId === 'card-123' && s.user?.id === ada.userId,
        ),
      { message: 'awareness on node B' },
    );
  });

  it('control events reach sockets on every node', async () => {
    const [nodeA, nodeB] = await twoNodes();
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const onA = track(connect(nodeA.url, fx.boardId, ada.token));
    const onB = track(connect(nodeB.url, fx.boardId, ada.token));
    await Promise.all([onA.synced, onB.synced]);
    const redis = new Redis(process.env.REDIS_URL!);
    await redis.publish(
      SERVER_EVENTS_CHANNEL,
      JSON.stringify({ type: 'board-deleted', boardId: fx.boardId }),
    );
    await redis.quit();
    expect(await onA.closed).toBe('board-deleted');
    expect(await onB.closed).toBe('board-deleted');
  });
});
