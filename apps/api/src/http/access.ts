import { can, uuidParam, type Permission, type Role } from '@huddle/shared';
import { getBoardAccess, getWorkspaceRole, type BoardAccess, type Database } from '@huddle/db';
import { forbidden, notFound } from './errors';

/** Malformed ids are a 404, not a 500 from Postgres' uuid parser. */
export function parseId(value: unknown, what = 'Resource'): string {
  const parsed = uuidParam.safeParse(value);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
}

/**
 * Non-members get 404 (not 403) so workspace and board ids cannot be probed
 * for existence. Members lacking the permission get 403.
 */
export async function requireWorkspacePermission(
  db: Database,
  userId: string,
  workspaceIdRaw: unknown,
  permission: Permission,
): Promise<{ workspaceId: string; role: Role }> {
  const workspaceId = parseId(workspaceIdRaw, 'Workspace');
  const role = await getWorkspaceRole(db, userId, workspaceId);
  if (!role) throw notFound('Workspace not found');
  if (!can(role, permission)) throw forbidden();
  return { workspaceId, role };
}

export async function requireBoardPermission(
  db: Database,
  userId: string,
  boardIdRaw: unknown,
  permission: Permission,
): Promise<BoardAccess & { role: Role }> {
  const boardId = parseId(boardIdRaw, 'Board');
  const access = await getBoardAccess(db, userId, boardId);
  if (!access || !access.role) throw notFound('Board not found');
  if (!can(access.role, permission)) throw forbidden();
  return { ...access, role: access.role };
}
