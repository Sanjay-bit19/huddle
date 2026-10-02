import { Router } from 'express';
import { and, asc, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { boards, invites, users, workspaceMembers, workspaces } from '@huddle/db';
import {
  createInviteSchema,
  createWorkspaceSchema,
  decideMemberRemoval,
  decideRoleChange,
  updateMemberSchema,
  updateWorkspaceSchema,
  type InviteDto,
  type MemberDto,
  type WorkspaceSummary,
} from '@huddle/shared';
import { generateOpaqueToken, hashToken } from '../auth/tokens';
import type { AppDeps } from '../deps';
import { requireWorkspacePermission, parseId } from '../http/access';
import { authOf } from '../http/auth-middleware';
import { conflict, forbidden, notFound } from '../http/errors';
import { parse } from '../http/validate';

export function workspacesRouter(deps: AppDeps): Router {
  const { db, events } = deps;
  const router = Router();
  router.use(deps.requireAuth);

  router.get('/', async (req, res) => {
    const { userId } = authOf(req);
    const memberCount = db
      .select({ c: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaces.id));
    const boardCount = db
      .select({ c: count() })
      .from(boards)
      .where(eq(boards.workspaceId, workspaces.id));
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        createdAt: workspaces.createdAt,
        memberCount: sql<number>`(${memberCount})::int`,
        boardCount: sql<number>`(${boardCount})::int`,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaces.name));
    const body: WorkspaceSummary[] = rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ workspaces: body });
  });

  router.post('/', async (req, res) => {
    const { userId } = authOf(req);
    const { name } = parse(createWorkspaceSchema, req.body);
    const workspace = await db.transaction(async (tx) => {
      const [ws] = await tx.insert(workspaces).values({ name, createdBy: userId }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId, role: 'ADMIN' });
      return ws!;
    });
    res.status(201).json({ workspace: { ...workspace, role: 'ADMIN' } });
  });

  router.get('/:workspaceId', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId, role } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'workspace:read',
    );
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) throw notFound('Workspace not found');
    res.json({ workspace: { id: ws.id, name: ws.name, createdAt: ws.createdAt, role } });
  });

  router.patch('/:workspaceId', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'workspace:update',
    );
    const { name } = parse(updateWorkspaceSchema, req.body);
    const [ws] = await db
      .update(workspaces)
      .set({ name })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    res.json({ workspace: ws });
  });

  router.delete('/:workspaceId', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'workspace:delete',
    );
    const deleted = await db.transaction(async (tx) => {
      const boardRows = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(eq(boards.workspaceId, workspaceId));
      await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
      return boardRows;
    });
    // Disconnect anyone still editing a board of the deleted workspace.
    await Promise.all(deleted.map((b) => events.publish({ type: 'board-deleted', boardId: b.id })));
    res.status(204).end();
  });

  // ---- members -------------------------------------------------------------

  router.get('/:workspaceId/members', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'member:list',
    );
    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(users.name));
    const members: MemberDto[] = rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
    res.json({ members });
  });

  /** Loads the target member and the admin count under row locks. */
  async function lockMembership(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    workspaceId: string,
    targetId: string,
  ) {
    // Locking every member row of the workspace serializes concurrent role
    // changes, so two admins cannot demote each other at the same time and
    // leave the workspace with zero admins.
    const rows = await tx
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .for('update');
    const target = rows.find((r) => r.userId === targetId);
    const adminCount = rows.filter((r) => r.role === 'ADMIN').length;
    return { target, adminCount, rows };
  }

  router.patch('/:workspaceId/members/:userId', async (req, res) => {
    const { userId: actorId } = authOf(req);
    const workspaceId = parseId(req.params.workspaceId, 'Workspace');
    const targetId = parseId(req.params.userId, 'Member');
    const { role: newRole } = parse(updateMemberSchema, req.body);

    await db.transaction(async (tx) => {
      const { target, adminCount, rows } = await lockMembership(tx, workspaceId, targetId);
      const actorRole = rows.find((r) => r.userId === actorId)?.role ?? null;
      if (!actorRole) throw notFound('Workspace not found');
      if (!target) throw notFound('Member not found');
      const decision = decideRoleChange({
        actorRole,
        targetRole: target.role,
        newRole,
        adminCount,
      });
      if (!decision.ok) {
        throw decision.reason === 'last_admin'
          ? conflict('A workspace needs at least one admin')
          : forbidden();
      }
      await tx
        .update(workspaceMembers)
        .set({ role: newRole })
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)),
        );
    });
    // Live sockets pick up the new role (e.g. EDITOR -> VIEWER becomes read-only now).
    await events.publish({ type: 'membership-changed', workspaceId, userId: targetId });
    res.json({ ok: true });
  });

  router.delete('/:workspaceId/members/:userId', async (req, res) => {
    const { userId: actorId } = authOf(req);
    const workspaceId = parseId(req.params.workspaceId, 'Workspace');
    const targetId = parseId(req.params.userId, 'Member');

    await db.transaction(async (tx) => {
      const { target, adminCount, rows } = await lockMembership(tx, workspaceId, targetId);
      const actorRole = rows.find((r) => r.userId === actorId)?.role ?? null;
      if (!actorRole) throw notFound('Workspace not found');
      if (!target) throw notFound('Member not found');
      const decision = decideMemberRemoval({
        actorId,
        actorRole,
        targetId,
        targetRole: target.role,
        adminCount,
      });
      if (!decision.ok) {
        throw decision.reason === 'last_admin'
          ? conflict('A workspace needs at least one admin')
          : forbidden();
      }
      await tx
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)),
        );
    });
    await events.publish({ type: 'membership-changed', workspaceId, userId: targetId });
    res.status(204).end();
  });

  // ---- invites -------------------------------------------------------------

  router.get('/:workspaceId/invites', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'invite:manage',
    );
    const rows = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, new Date()),
          or(isNull(invites.maxUses), sql`${invites.useCount} < ${invites.maxUses}`),
        ),
      )
      .orderBy(desc(invites.createdAt));
    const body: InviteDto[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      expiresAt: r.expiresAt.toISOString(),
      maxUses: r.maxUses,
      useCount: r.useCount,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    }));
    res.json({ invites: body });
  });

  router.post('/:workspaceId/invites', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'invite:manage',
    );
    const input = parse(createInviteSchema, req.body ?? {});
    const token = generateOpaqueToken();
    const [invite] = await db
      .insert(invites)
      .values({
        workspaceId,
        tokenHash: hashToken(token),
        role: input.role,
        createdBy: userId,
        expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000),
        maxUses: input.maxUses,
      })
      .returning();
    // The raw token is returned exactly once; only its hash is stored.
    res.status(201).json({
      invite: {
        id: invite!.id,
        role: invite!.role,
        expiresAt: invite!.expiresAt.toISOString(),
        maxUses: invite!.maxUses,
        useCount: 0,
      },
      token,
      url: `${deps.config.APP_URL}/invite/${token}`,
    });
  });

  router.delete('/:workspaceId/invites/:inviteId', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'invite:manage',
    );
    const inviteId = parseId(req.params.inviteId, 'Invite');
    const [row] = await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, workspaceId)))
      .returning({ id: invites.id });
    if (!row) throw notFound('Invite not found');
    res.status(204).end();
  });

  return router;
}
