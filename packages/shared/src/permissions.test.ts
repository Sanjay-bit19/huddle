import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  can,
  canDeleteComment,
  decideMemberRemoval,
  decideRoleChange,
  type Permission,
  type Role,
} from './permissions';

describe('can()', () => {
  // The full matrix, spelled out so any change to it is a deliberate test edit.
  const matrix: Record<Permission, Record<Role, boolean>> = {
    'workspace:read': { ADMIN: true, EDITOR: true, VIEWER: true },
    'workspace:update': { ADMIN: true, EDITOR: false, VIEWER: false },
    'workspace:delete': { ADMIN: true, EDITOR: false, VIEWER: false },
    'member:list': { ADMIN: true, EDITOR: true, VIEWER: true },
    'member:manage': { ADMIN: true, EDITOR: false, VIEWER: false },
    'invite:manage': { ADMIN: true, EDITOR: false, VIEWER: false },
    'board:read': { ADMIN: true, EDITOR: true, VIEWER: true },
    'board:create': { ADMIN: true, EDITOR: true, VIEWER: false },
    'board:update': { ADMIN: true, EDITOR: true, VIEWER: false },
    'board:delete': { ADMIN: true, EDITOR: false, VIEWER: false },
    'board:write': { ADMIN: true, EDITOR: true, VIEWER: false },
    'comment:read': { ADMIN: true, EDITOR: true, VIEWER: true },
    'comment:create': { ADMIN: true, EDITOR: true, VIEWER: false },
    'comment:moderate': { ADMIN: true, EDITOR: false, VIEWER: false },
    'activity:read': { ADMIN: true, EDITOR: true, VIEWER: true },
    'search:query': { ADMIN: true, EDITOR: true, VIEWER: true },
    'ai:read': { ADMIN: true, EDITOR: true, VIEWER: true },
    'ai:write': { ADMIN: true, EDITOR: true, VIEWER: false },
  };

  it('covers every permission', () => {
    expect(Object.keys(matrix).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const [permission, byRole] of Object.entries(matrix)) {
    for (const role of ROLES) {
      it(`${role} ${byRole[role] ? 'can' : 'cannot'} ${permission}`, () => {
        expect(can(role, permission as Permission)).toBe(byRole[role]);
      });
    }
  }

  it('denies non-members everything', () => {
    for (const p of Object.keys(PERMISSIONS) as Permission[]) {
      expect(can(null, p)).toBe(false);
      expect(can(undefined, p)).toBe(false);
    }
  });

  it('viewers can never write board content', () => {
    expect(can('VIEWER', 'board:write')).toBe(false);
  });
});

describe('decideRoleChange', () => {
  it('only admins can change roles', () => {
    for (const actorRole of ['EDITOR', 'VIEWER', null] as const) {
      expect(
        decideRoleChange({ actorRole, targetRole: 'VIEWER', newRole: 'EDITOR', adminCount: 1 }),
      ).toEqual({ ok: false, reason: 'forbidden' });
    }
    expect(
      decideRoleChange({
        actorRole: 'ADMIN',
        targetRole: 'VIEWER',
        newRole: 'ADMIN',
        adminCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses to demote the last admin', () => {
    expect(
      decideRoleChange({
        actorRole: 'ADMIN',
        targetRole: 'ADMIN',
        newRole: 'EDITOR',
        adminCount: 1,
      }),
    ).toEqual({ ok: false, reason: 'last_admin' });
  });

  it('allows demoting an admin when another admin remains', () => {
    expect(
      decideRoleChange({
        actorRole: 'ADMIN',
        targetRole: 'ADMIN',
        newRole: 'VIEWER',
        adminCount: 2,
      }),
    ).toEqual({ ok: true });
  });
});

describe('decideMemberRemoval', () => {
  const base = { actorId: 'a', targetId: 'b', targetRole: 'EDITOR' as Role, adminCount: 1 };

  it('admins can remove others', () => {
    expect(decideMemberRemoval({ ...base, actorRole: 'ADMIN' })).toEqual({ ok: true });
  });

  it('non-admins cannot remove others', () => {
    expect(decideMemberRemoval({ ...base, actorRole: 'EDITOR' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('anyone can leave', () => {
    expect(
      decideMemberRemoval({ ...base, actorRole: 'VIEWER', targetId: 'a', targetRole: 'VIEWER' }),
    ).toEqual({ ok: true });
  });

  it('the last admin cannot leave or be removed', () => {
    expect(
      decideMemberRemoval({ ...base, actorRole: 'ADMIN', targetId: 'a', targetRole: 'ADMIN' }),
    ).toEqual({ ok: false, reason: 'last_admin' });
  });

  it('non-members cannot even leave', () => {
    expect(decideMemberRemoval({ ...base, actorRole: null, targetId: 'a' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});

describe('canDeleteComment', () => {
  it('authors can delete their own comments', () => {
    expect(canDeleteComment({ actorId: 'u', actorRole: 'EDITOR', authorId: 'u' })).toBe(true);
  });
  it('admins can moderate', () => {
    expect(canDeleteComment({ actorId: 'x', actorRole: 'ADMIN', authorId: 'u' })).toBe(true);
  });
  it('others cannot', () => {
    expect(canDeleteComment({ actorId: 'x', actorRole: 'EDITOR', authorId: 'u' })).toBe(false);
    expect(canDeleteComment({ actorId: 'u', actorRole: null, authorId: 'u' })).toBe(false);
  });
});
