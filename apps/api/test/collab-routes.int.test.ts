import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityEvents, appendBoardUpdates, loadBoardDoc, syncCardSearch } from '@huddle/db';
import { addCard, readBoard } from '@huddle/shared/board';
import { createTestContext, createUser, type TestContext, type TestUser } from './helpers';

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

async function setup() {
  const ada = await createUser(ctx, 'Ada');
  const ws = await request(ctx.app).post('/api/workspaces').set(ada.auth).send({ name: 'Acme' });
  const workspaceId = ws.body.workspace.id as string;
  const board = await request(ctx.app)
    .post(`/api/workspaces/${workspaceId}/boards`)
    .set(ada.auth)
    .send({ title: 'Launch' });
  const boardId = board.body.board.id as string;
  const doc = await loadBoardDoc(ctx.deps.db, boardId);
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  const cardId = addCard(doc, { columnId: readBoard(doc).columns[0]!.id, title: 'Write docs' });
  await appendBoardUpdates(
    ctx.deps.db,
    updates.map((update) => ({ boardId, update, userId: null })),
  );
  return { ada, workspaceId, boardId, cardId, view: readBoard(doc) };
}

async function member(owner: TestUser, workspaceId: string, role: string, name: string) {
  const user = await createUser(ctx, name);
  const inv = await request(ctx.app)
    .post(`/api/workspaces/${workspaceId}/invites`)
    .set(owner.auth)
    .send({ role });
  await request(ctx.app).post(`/api/invites/${inv.body.token}/accept`).set(user.auth).expect(200);
  return user;
}

describe('comments', () => {
  it('editors comment, everyone reads, author or admin deletes', async () => {
    const { ada, workspaceId, boardId, cardId } = await setup();
    const bob = await member(ada, workspaceId, 'EDITOR', 'Bob');
    const vic = await member(ada, workspaceId, 'VIEWER', 'Vic');
    const path = `/api/boards/${boardId}/cards/${cardId}/comments`;

    const created = await request(ctx.app)
      .post(path)
      .set(bob.auth)
      .send({ body: '  Looks good  ' })
      .expect(201);
    expect(created.body.comment).toMatchObject({
      body: 'Looks good',
      author: { id: bob.id, name: 'Bob' },
    });
    await request(ctx.app).post(path).set(vic.auth).send({ body: 'hi' }).expect(403);
    await request(ctx.app).post(path).set(bob.auth).send({ body: '' }).expect(400);
    await request(ctx.app)
      .post(`/api/boards/${boardId}/cards/no-such-card/comments`)
      .set(bob.auth)
      .send({ body: 'x' })
      .expect(404);

    const list = await request(ctx.app).get(path).set(vic.auth).expect(200);
    expect(list.body.comments).toHaveLength(1);

    // Live update fan-out and an activity entry.
    expect(ctx.events).toContainEqual({
      type: 'board-broadcast',
      boardId,
      payload: { kind: 'comments-changed', cardId },
    });
    const [activity] = await ctx.deps.db.select().from(activityEvents);
    expect(activity).toMatchObject({
      type: 'comment.added',
      actorId: bob.id,
      cardId,
      data: { title: 'Write docs' },
    });

    const commentId = created.body.comment.id;
    const carol = await member(ada, workspaceId, 'EDITOR', 'Carol');
    await request(ctx.app)
      .delete(`/api/boards/${boardId}/comments/${commentId}`)
      .set(carol.auth)
      .expect(403);
    await request(ctx.app)
      .delete(`/api/boards/${boardId}/comments/${commentId}`)
      .set(ada.auth)
      .expect(204);
    expect((await request(ctx.app).get(path).set(bob.auth)).body.comments).toHaveLength(0);
  });

  it('is invisible to non-members', async () => {
    const { boardId, cardId } = await setup();
    const eve = await createUser(ctx, 'Eve');
    await request(ctx.app)
      .get(`/api/boards/${boardId}/cards/${cardId}/comments`)
      .set(eve.auth)
      .expect(404);
  });
});

describe('activity feed', () => {
  it('pages newest first and filters by card', async () => {
    const { ada, boardId, cardId } = await setup();
    await ctx.deps.db.insert(activityEvents).values(
      Array.from({ length: 5 }, (_, i) => ({
        boardId,
        actorId: ada.id,
        type: 'card.renamed',
        cardId: i % 2 ? cardId : 'other',
        data: { from: `t${i}`, to: `t${i + 1}` },
      })),
    );
    const page1 = await request(ctx.app)
      .get(`/api/boards/${boardId}/activity?limit=3`)
      .set(ada.auth)
      .expect(200);
    expect(page1.body.items.map((i: { data: { from: string } }) => i.data.from)).toEqual([
      't4',
      't3',
      't2',
    ]);
    expect(page1.body.items[0].actor).toEqual({ id: ada.id, name: 'Ada' });
    const page2 = await request(ctx.app)
      .get(`/api/boards/${boardId}/activity?limit=3&before=${page1.body.nextBefore}`)
      .set(ada.auth)
      .expect(200);
    expect(page2.body.items.map((i: { data: { from: string } }) => i.data.from)).toEqual([
      't1',
      't0',
    ]);
    expect(page2.body.nextBefore).toBeNull();
    const forCard = await request(ctx.app)
      .get(`/api/boards/${boardId}/activity?cardId=${cardId}`)
      .set(ada.auth);
    expect(forCard.body.items).toHaveLength(2);
  });
});

describe('search', () => {
  it('searches the workspace for members only', async () => {
    const { ada, workspaceId, boardId, view } = await setup();
    await syncCardSearch(ctx.deps.db, boardId, view);
    const res = await request(ctx.app)
      .get(`/api/workspaces/${workspaceId}/search?q=doc`)
      .set(ada.auth)
      .expect(200);
    expect(res.body.hits).toEqual([
      expect.objectContaining({
        title: 'Write docs',
        boardId,
        boardTitle: 'Launch',
        columnTitle: 'To do',
      }),
    ]);
    // Operators and punctuation are stripped, never interpreted.
    await request(ctx.app)
      .get(`/api/workspaces/${workspaceId}/search?q=${encodeURIComponent("doc' | !:*")}`)
      .set(ada.auth)
      .expect(200);
    await request(ctx.app)
      .get(`/api/workspaces/${workspaceId}/search?q=`)
      .set(ada.auth)
      .expect(400);
    const eve = await createUser(ctx, 'Eve');
    await request(ctx.app)
      .get(`/api/workspaces/${workspaceId}/search?q=doc`)
      .set(eve.auth)
      .expect(404);
  });
});
