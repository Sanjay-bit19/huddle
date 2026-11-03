/**
 * Single source of truth for authorization, imported by the API (HTTP routes),
 * the collab server (WebSocket writes) and the web app (to hide controls).
 * The client copy is UX only; the servers are authoritative.
 */

export const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const WRITERS: readonly Role[] = ['ADMIN', 'EDITOR'];
const ADMINS: readonly Role[] = ['ADMIN'];

export const PERMISSIONS = {
  'workspace:read': ALL,
  'workspace:update': ADMINS,
  'workspace:delete': ADMINS,
  'member:list': ALL,
  'member:manage': ADMINS,
  'invite:manage': ADMINS,
  'board:read': ALL,
  'board:create': WRITERS,
  'board:update': WRITERS,
  'board:delete': ADMINS,
  /** Mutating the board's Yjs document over the WebSocket. */
  'board:write': WRITERS,
  'comment:read': ALL,
  'comment:create': WRITERS,
  /** Deleting someone else's comment (authors can always delete their own). */
  'comment:moderate': ADMINS,
  'activity:read': ALL,
  'search:query': ALL,
  /** Read-only AI (summarize, ask): costs tokens but cannot change the board. */
  'ai:read': ALL,
  /** AI that proposes board changes (notes to cards). */
  'ai:write': WRITERS,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export const roleRank: Record<Role, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2 };

export type Decision = { ok: true } | { ok: false; reason: 'forbidden' | 'last_admin' };

const allow: Decision = { ok: true };
const deny = (reason: 'forbidden' | 'last_admin'): Decision => ({ ok: false, reason });

/**
 * Changing a member's role. Admin-only, and a workspace can never be left
 * without an admin (otherwise nobody could manage it again).
 */
export function decideRoleChange(input: {
  actorRole: Role | null;
  targetRole: Role;
  newRole: Role;
  adminCount: number;
}): Decision {
  if (!can(input.actorRole, 'member:manage')) return deny('forbidden');
  if (input.targetRole === 'ADMIN' && input.newRole !== 'ADMIN' && input.adminCount <= 1) {
    return deny('last_admin');
  }
  return allow;
}

/** Removing a member: admins can remove anyone, anyone can leave, last admin cannot go. */
export function decideMemberRemoval(input: {
  actorId: string;
  actorRole: Role | null;
  targetId: string;
  targetRole: Role;
  adminCount: number;
}): Decision {
  const self = input.actorId === input.targetId;
  if (!self && !can(input.actorRole, 'member:manage')) return deny('forbidden');
  if (!input.actorRole) return deny('forbidden');
  if (input.targetRole === 'ADMIN' && input.adminCount <= 1) return deny('last_admin');
  return allow;
}

/** Deleting a comment: its author, or a moderator. */
export function canDeleteComment(input: {
  actorId: string;
  actorRole: Role | null;
  authorId: string | null;
}): boolean {
  if (!input.actorRole) return false;
  return input.actorId === input.authorId || can(input.actorRole, 'comment:moderate');
}
