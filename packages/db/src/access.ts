import { and, eq, isNull } from 'drizzle-orm';
import type { Role } from '@huddle/shared';
import type { Database } from './client';
import { boards, sessions, workspaceMembers } from './schema';

/**
 * Membership lookups shared by the API and the collab server so both enforce
 * permissions from the same query.
 */
export async function getWorkspaceRole(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<Role | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

export interface BoardAccess {
  boardId: string;
  workspaceId: string;
  title: string;
  role: Role | null;
}

/** Board plus the caller's role in its workspace (null role = not a member). */
export async function getBoardAccess(
  db: Database,
  userId: string,
  boardId: string,
): Promise<BoardAccess | null> {
  const [row] = await db
    .select({
      boardId: boards.id,
      workspaceId: boards.workspaceId,
      title: boards.title,
      role: workspaceMembers.role,
    })
    .from(boards)
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, boards.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(eq(boards.id, boardId));
  return row ?? null;
}

/** True if the session exists, belongs to the user and has not been revoked. */
export async function isSessionLive(
  db: Database,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
    );
  return Boolean(row);
}
