import request from 'supertest';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function createWorkspace(owner: TestUser, name = 'Acme') {
  const res = await request(ctx.app)
    .post('/api/workspaces')
    .set(owner.auth)
    .send({ name })
    .expect(201);
  return res.body.workspace.id as string;
}

async function invite(owner: TestUser, workspaceId: string, body: Record<string, unknown> = {}) {
  const res = await request(ctx.app)
    .post(`/api/workspaces/${workspaceId}/invites`)
    .set(owner.auth)
    .send(body)
    .expect(201);
  return res.body as { token: string; url: string; invite: { id: string } };
}

function join(user: TestUser, token: string) {
  return request(ctx.app).post(`/api/invites/${token}/accept`).set(user.auth);
}

async function addMember(owner: TestUser, workspaceId: string, role: string, name = role) {
  const user = await createUser(ctx, name);
  const { token } = await invite(owner, workspaceId, { role });
  await join(user, token).expect(200);
  return user;
}

describe('workspaces', () => {
  it('creator becomes ADMIN and sees it in their list', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada, 'Analytical Engines');
    const res = await request(ctx.app).get('/api/workspaces').set(ada.auth).expect(200);
    expect(res.body.workspaces).toEqual([
      expect.objectContaining({
        id,
        name: 'Analytical Engines',
        role: 'ADMIN',
        memberCount: 1,
        boardCount: 0,
      }),
    ]);
  });

  it('hides workspaces from non-members with 404 (no existence oracle)', async () => {
    const ada = await createUser(ctx, 'Ada');
    const eve = await createUser(ctx, 'Eve');
    const id = await createWorkspace(ada);
    await request(ctx.app).get(`/api/workspaces/${id}`).set(eve.auth).expect(404);
    await request(ctx.app).get(`/api/workspaces/${id}/members`).set(eve.auth).expect(404);
    await request(ctx.app)
      .post(`/api/workspaces/${id}/boards`)
      .set(eve.auth)
      .send({ title: 'x' })
      .expect(404);
    // Malformed ids are 404s too, never a 500.
    await request(ctx.app).get('/api/workspaces/not-a-uuid').set(eve.auth).expect(404);
    expect((await request(ctx.app).get('/api/workspaces').set(eve.auth)).body.workspaces).toEqual(
      [],
    );
  });

  it('only admins can rename or delete', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const editor = await addMember(ada, id, 'EDITOR');
    await request(ctx.app)
      .patch(`/api/workspaces/${id}`)
      .set(editor.auth)
      .send({ name: 'Hijacked' })
      .expect(403);
    await request(ctx.app).delete(`/api/workspaces/${id}`).set(editor.auth).expect(403);
    await request(ctx.app)
      .patch(`/api/workspaces/${id}`)
      .set(ada.auth)
      .send({ name: 'Renamed' })
      .expect(200);
  });

  it('deleting a workspace notifies collab servers about its boards', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const board = await request(ctx.app)
      .post(`/api/workspaces/${id}/boards`)
      .set(ada.auth)
      .send({ title: 'Roadmap' })
      .expect(201);
    await request(ctx.app).delete(`/api/workspaces/${id}`).set(ada.auth).expect(204);
    expect(ctx.events).toContainEqual({ type: 'board-deleted', boardId: board.body.board.id });
    await request(ctx.app).get(`/api/boards/${board.body.board.id}`).set(ada.auth).expect(404);
  });
});

describe('invites', () => {
  it('preview works anonymously and accept grants the invite role', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada, 'Acme');
    const { token, url } = await invite(ada, id, { role: 'VIEWER' });
    expect(url).toContain(`/invite/${token}`);

    const preview = await request(ctx.app).get(`/api/invites/${token}`).expect(200);
    expect(preview.body.invite).toMatchObject({
      workspaceName: 'Acme',
      inviterName: 'Ada',
      role: 'VIEWER',
      valid: true,
    });

    const bob = await createUser(ctx, 'Bob');
    const accepted = await join(bob, token).expect(200);
    expect(accepted.body).toEqual({ workspaceId: id, role: 'VIEWER', alreadyMember: false });

    const members = await request(ctx.app)
      .get(`/api/workspaces/${id}/members`)
      .set(bob.auth)
      .expect(200);
    expect(members.body.members.map((m: { role: string }) => m.role).sort()).toEqual([
      'ADMIN',
      'VIEWER',
    ]);
  });

  it('stores only a hash of the token', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const { token } = await invite(ada, id);
    const { rows } = await ctx.deps.db.execute<{ token_hash: string }>(
      sql`select token_hash from invites`,
    );
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  it('requires authentication to accept', async () => {
    const ada = await createUser(ctx, 'Ada');
    const { token } = await invite(ada, await createWorkspace(ada));
    await request(ctx.app).post(`/api/invites/${token}/accept`).expect(401);
  });

  it('rejects expired invites', async () => {
    const ada = await createUser(ctx, 'Ada');
    const { token } = await invite(ada, await createWorkspace(ada));
    await ctx.deps.db.execute(sql`update invites set expires_at = now() - interval '1 minute'`);
    const preview = await request(ctx.app).get(`/api/invites/${token}`).expect(200);
    expect(preview.body.invite).toMatchObject({ valid: false, problem: 'This invite has expired' });
    const res = await join(await createUser(ctx, 'Late'), token).expect(410);
    expect(res.body.error.message).toBe('This invite has expired');
  });

  it('rejects revoked invites and hides them from the list', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const { token, invite: inv } = await invite(ada, id);
    await request(ctx.app)
      .delete(`/api/workspaces/${id}/invites/${inv.id}`)
      .set(ada.auth)
      .expect(204);
    await join(await createUser(ctx, 'Bob'), token).expect(410);
    const list = await request(ctx.app)
      .get(`/api/workspaces/${id}/invites`)
      .set(ada.auth)
      .expect(200);
    expect(list.body.invites).toEqual([]);
  });

  it('enforces maxUses even under concurrent accepts', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const { token } = await invite(ada, id, { maxUses: 1 });
    const [u1, u2, u3] = await Promise.all([
      createUser(ctx, 'U1'),
      createUser(ctx, 'U2'),
      createUser(ctx, 'U3'),
    ]);
    const results = await Promise.all([join(u1!, token), join(u2!, token), join(u3!, token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410]);
  });

  it('accepting as an existing member never changes their role', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const { token } = await invite(ada, id, { role: 'VIEWER' });
    const res = await join(ada, token).expect(200);
    expect(res.body).toEqual({ workspaceId: id, role: 'ADMIN', alreadyMember: true });
  });

  it('only admins manage invites', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const editor = await addMember(ada, id, 'EDITOR');
    await request(ctx.app)
      .post(`/api/workspaces/${id}/invites`)
      .set(editor.auth)
      .send({ role: 'ADMIN' })
      .expect(403);
    await request(ctx.app).get(`/api/workspaces/${id}/invites`).set(editor.auth).expect(403);
  });

  it('validates invite input', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    await request(ctx.app)
      .post(`/api/workspaces/${id}/invites`)
      .set(ada.auth)
      .send({ role: 'OWNER', expiresInHours: 99999 })
      .expect(400);
  });
});

describe('roles', () => {
  it('admin can change roles and collab servers are notified', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const bob = await addMember(ada, id, 'EDITOR');
    await request(ctx.app)
      .patch(`/api/workspaces/${id}/members/${bob.id}`)
      .set(ada.auth)
      .send({ role: 'VIEWER' })
      .expect(200);
    expect(ctx.events).toContainEqual({
      type: 'membership-changed',
      workspaceId: id,
      userId: bob.id,
    });
    // As a viewer Bob can no longer create boards.
    await request(ctx.app)
      .post(`/api/workspaces/${id}/boards`)
      .set(bob.auth)
      .send({ title: 'Nope' })
      .expect(403);
  });

  it('non-admins cannot change roles (including their own)', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const bob = await addMember(ada, id, 'EDITOR');
    await request(ctx.app)
      .patch(`/api/workspaces/${id}/members/${bob.id}`)
      .set(bob.auth)
      .send({ role: 'ADMIN' })
      .expect(403);
  });

  it('protects the last admin', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    await request(ctx.app)
      .patch(`/api/workspaces/${id}/members/${ada.id}`)
      .set(ada.auth)
      .send({ role: 'EDITOR' })
      .expect(409);
    await request(ctx.app)
      .delete(`/api/workspaces/${id}/members/${ada.id}`)
      .set(ada.auth)
      .expect(409);
  });

  it('two admins demoting each other concurrently cannot leave zero admins', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const bob = await addMember(ada, id, 'ADMIN');
    const [r1, r2] = await Promise.all([
      request(ctx.app)
        .patch(`/api/workspaces/${id}/members/${bob.id}`)
        .set(ada.auth)
        .send({ role: 'EDITOR' }),
      request(ctx.app)
        .patch(`/api/workspaces/${id}/members/${ada.id}`)
        .set(bob.auth)
        .send({ role: 'EDITOR' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 403].sort());
    const { rows } = await ctx.deps.db.execute<{ c: number }>(
      sql`select count(*)::int as c from workspace_members where role = 'ADMIN'`,
    );
    expect(rows[0]!.c).toBe(1);
  });

  it('members can leave; admins can remove others', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const bob = await addMember(ada, id, 'VIEWER');
    const cat = await addMember(ada, id, 'EDITOR');
    await request(ctx.app)
      .delete(`/api/workspaces/${id}/members/${bob.id}`)
      .set(bob.auth)
      .expect(204);
    await request(ctx.app)
      .delete(`/api/workspaces/${id}/members/${ada.id}`)
      .set(cat.auth)
      .expect(403);
    await request(ctx.app)
      .delete(`/api/workspaces/${id}/members/${cat.id}`)
      .set(ada.auth)
      .expect(204);
    await request(ctx.app).get(`/api/workspaces/${id}`).set(cat.auth).expect(404);
  });
});

describe('boards', () => {
  it('editors create and rename; viewers read only; admins delete', async () => {
    const ada = await createUser(ctx, 'Ada');
    const id = await createWorkspace(ada);
    const editor = await addMember(ada, id, 'EDITOR');
    const viewer = await addMember(ada, id, 'VIEWER');

    const created = await request(ctx.app)
      .post(`/api/workspaces/${id}/boards`)
      .set(editor.auth)
      .send({ title: '  Q3 Roadmap ' })
      .expect(201);
    const boardId = created.body.board.id;
    expect(created.body.board.title).toBe('Q3 Roadmap');

    await request(ctx.app)
      .post(`/api/workspaces/${id}/boards`)
      .set(viewer.auth)
      .send({ title: 'x' })
      .expect(403);

    const got = await request(ctx.app).get(`/api/boards/${boardId}`).set(viewer.auth).expect(200);
    expect(got.body).toMatchObject({ role: 'VIEWER', workspace: { id } });

    await request(ctx.app)
      .patch(`/api/boards/${boardId}`)
      .set(viewer.auth)
      .send({ title: 'x' })
      .expect(403);
    await request(ctx.app)
      .patch(`/api/boards/${boardId}`)
      .set(editor.auth)
      .send({ title: 'Q4 Roadmap' })
      .expect(200);
    await request(ctx.app).patch(`/api/boards/${boardId}`).set(editor.auth).send({}).expect(400);

    await request(ctx.app).delete(`/api/boards/${boardId}`).set(editor.auth).expect(403);
    await request(ctx.app).delete(`/api/boards/${boardId}`).set(ada.auth).expect(204);
    expect(ctx.events).toContainEqual({ type: 'board-deleted', boardId });

    const list = await request(ctx.app)
      .get(`/api/workspaces/${id}/boards`)
      .set(viewer.auth)
      .expect(200);
    expect(list.body.boards).toEqual([]);
  });

  it('boards are invisible across workspaces', async () => {
    const ada = await createUser(ctx, 'Ada');
    const eve = await createUser(ctx, 'Eve');
    const id = await createWorkspace(ada);
    const board = await request(ctx.app)
      .post(`/api/workspaces/${id}/boards`)
      .set(ada.auth)
      .send({ title: 'Secret' })
      .expect(201);
    await request(ctx.app).get(`/api/boards/${board.body.board.id}`).set(eve.auth).expect(404);
    await request(ctx.app)
      .patch(`/api/boards/${board.body.board.id}`)
      .set(eve.auth)
      .send({ title: 'pwned' })
      .expect(404);
  });
});
