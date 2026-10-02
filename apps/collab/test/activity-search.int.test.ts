import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityEvents, cardSearch, searchCards, type DbHandle } from '@huddle/db';
import { addCard, moveCard, readBoard, updateCard } from '@huddle/shared/board';
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
const track = (c: TestClient) => (clients.push(c), c);

describe('activity log', () => {
  it('records semantic, attributed entries exactly once across two nodes', async () => {
    const prefix = `act-${randomUUID().slice(0, 8)}`;
    const a = await startCollab(handle, { prefix, instanceId: 'a' });
    const b = await startCollab(handle, { prefix, instanceId: 'b' });
    nodes.push(a, b);
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const vic = await fx.member('VIEWER', 'vic');
    const onA = track(connect(a.url, fx.boardId, ada.token));
    const onB = track(connect(b.url, fx.boardId, vic.token));
    await Promise.all([onA.synced, onB.synced]);
    const [todo, , done] = readBoard(onA.doc).columns;

    const id = addCard(onA.doc, { columnId: todo!.id, title: 'Ship it' });
    moveCard(onA.doc, id, done!.id, 0);
    updateCard(onA.doc, id, { title: 'Ship it!' });
    // A rejected viewer write must never show up in the log.
    addCard(onB.doc, { columnId: todo!.id, title: 'sneaky' });

    await waitFor(async () => (await handle.db.select().from(activityEvents)).length >= 3, {
      message: 'activity rows',
    });
    await sleep(800);
    const rows = await handle.db.select().from(activityEvents).orderBy(activityEvents.id);
    expect(rows.map((r) => [r.type, r.actorId])).toEqual([
      ['card.created', ada.userId],
      ['card.moved', ada.userId],
      ['card.renamed', ada.userId],
    ]);
    expect(rows[1]!.data).toEqual({ title: 'Ship it', from: 'To do', to: 'Done' });
    // Node B saw all three changes (via Redis) but did not log them again.
    await waitFor(() => readBoard(onB.doc).cards.some((c) => c.title === 'Ship it!'));
  });

  it('notifies clients that the activity feed changed', async () => {
    const node = await startCollab(handle, { prefix: `act-${randomUUID().slice(0, 8)}` });
    nodes.push(node);
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const bob = await fx.member('EDITOR', 'bob');
    const c1 = track(connect(node.url, fx.boardId, ada.token));
    const c2 = track(connect(node.url, fx.boardId, bob.token));
    await Promise.all([c1.synced, c2.synced]);
    addCard(c1.doc, { columnId: readBoard(c1.doc).columns[0]!.id, title: 'x' });
    await waitFor(() => c2.statelessMessages.some((m) => m.includes('"activity"')), {
      message: 'activity stateless message',
    });
  });
});

describe('search projection', () => {
  it('indexes cards when the document is compacted and keeps it in sync', async () => {
    const node = await startCollab(handle, { prefix: `srch-${randomUUID().slice(0, 8)}` });
    nodes.push(node);
    const fx = await createFixture(handle);
    const ada = await fx.member('EDITOR', 'ada');
    const c = track(connect(node.url, fx.boardId, ada.token));
    await c.synced;
    const col = readBoard(c.doc).columns[0]!.id;
    const id = addCard(c.doc, {
      columnId: col,
      title: 'Database migration',
      description: 'Move the billing tables to Postgres 17',
      labels: ['infra'],
    });
    addCard(c.doc, { columnId: col, title: 'Marketing site' });

    await waitFor(async () => (await handle.db.select().from(cardSearch)).length === 2, {
      message: 'search rows',
    });
    // Prefix search across title, labels and description, scoped to the workspace.
    const byPrefix = await searchCards(handle.db, fx.workspaceId, 'migr');
    expect(byPrefix.map((h) => h.cardId)).toEqual([id]);
    const byBody = await searchCards(handle.db, fx.workspaceId, 'billing postgres');
    expect(byBody[0]).toMatchObject({ cardId: id, columnTitle: 'To do', boardTitle: 'Test board' });
    expect(byBody[0]!.snippet).toContain('<<');
    expect(await searchCards(handle.db, fx.workspaceId, 'infra')).toHaveLength(1);
    const other = await createFixture(handle);
    expect(await searchCards(handle.db, other.workspaceId, 'migration')).toEqual([]);

    // Deleting the card removes it from the index on the next compaction.
    c.doc.getMap('cards').delete(id);
    await waitFor(async () => (await handle.db.select().from(cardSearch)).length === 1, {
      message: 'deleted card leaves index',
    });
  });
});
