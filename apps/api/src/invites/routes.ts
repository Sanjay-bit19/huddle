import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { invites, users, workspaceMembers, workspaces, type DbInvite } from '@huddle/db';
import { hashToken } from '@huddle/shared/server';
import type { AppDeps } from '../deps';
import { authOf } from '../http/auth-middleware';
import { HttpError, notFound } from '../http/errors';
import { createRateLimiter } from '../http/rate-limit';

const gone = (message: string) => new HttpError(410, 'invite_unavailable', message);

function inviteProblem(invite: DbInvite): string | null {
  if (invite.revokedAt) return 'This invite has been revoked';
  if (invite.expiresAt.getTime() <= Date.now()) return 'This invite has expired';
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return 'This invite has reached its usage limit';
  }
  return null;
}

export function invitesRouter(deps: AppDeps): Router {
  const { db } = deps;
  const router = Router();

  // Tokens carry 256 bits of entropy, so guessing is hopeless; the limiter
  // just keeps the endpoint from being used as a cheap DB load generator.
  const limiter = createRateLimiter(
    deps.redis,
    { keyPrefix: 'invite', points: 30, durationSeconds: 60, key: (req) => req.ip ?? 'unknown' },
    deps.config.RATE_LIMIT_DISABLED,
  );

  /** Preview, readable before signing in so the invite page can say where it leads. */
  router.get('/:token', limiter, async (req, res) => {
    const [row] = await db
      .select({ invite: invites, workspaceName: workspaces.name, inviterName: users.name })
      .from(invites)
      .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
      .leftJoin(users, eq(users.id, invites.createdBy))
      .where(eq(invites.tokenHash, hashToken(String(req.params.token))));
    if (!row) throw notFound('Invite not found');
    const problem = inviteProblem(row.invite);
    res.json({
      invite: {
        workspaceId: row.invite.workspaceId,
        workspaceName: row.workspaceName,
        inviterName: row.inviterName,
        role: row.invite.role,
        expiresAt: row.invite.expiresAt.toISOString(),
        valid: problem === null,
        problem,
      },
    });
  });

  router.post('/:token/accept', limiter, deps.requireAuth, async (req, res) => {
    const { userId } = authOf(req);
    const result = await db.transaction(async (tx) => {
      // Row lock so concurrent accepts cannot exceed max_uses.
      const [invite] = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(String(req.params.token))))
        .for('update');
      if (!invite) throw notFound('Invite not found');

      const [existing] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, invite.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      // Already a member: accepting is a no-op. An invite never changes an
      // existing role (it could otherwise be used to downgrade an admin).
      if (existing) {
        return { workspaceId: invite.workspaceId, role: existing.role, alreadyMember: true };
      }

      const problem = inviteProblem(invite);
      if (problem) throw gone(problem);

      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: invite.workspaceId, userId, role: invite.role });
      await tx
        .update(invites)
        .set({ useCount: sql`${invites.useCount} + 1` })
        .where(eq(invites.id, invite.id));
      return { workspaceId: invite.workspaceId, role: invite.role, alreadyMember: false };
    });
    res.json(result);
  });

  return router;
}
