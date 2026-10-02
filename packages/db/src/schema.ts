import { ROLES } from '@huddle/shared';
import {
  bigserial,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stored lower-cased (normalized by the Zod schema at the boundary).
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

/**
 * A login session == one refresh-token rotation family. Access tokens carry
 * the session id (`sid`), and every authenticated request checks the session
 * is not revoked, so logout / logout-everywhere / reuse detection invalidate
 * outstanding access tokens immediately instead of after their TTL.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason', {
      enum: ['logout', 'logout_all', 'reuse_detected'],
    }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/**
 * Opaque refresh tokens, stored as SHA-256 hashes (a DB leak does not leak
 * usable tokens). Every refresh marks the presented token used and issues its
 * successor in the same session. Presenting an already-used token means a
 * stolen token was replayed, so the whole session is revoked (reuse detection).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_idx').on(t.tokenHash),
    index('refresh_tokens_session_idx').on(t.sessionId),
  ],
);

export type DbUser = typeof users.$inferSelect;
export type DbSession = typeof sessions.$inferSelect;
export type DbRefreshToken = typeof refreshTokens.$inferSelect;

// ---------------------------------------------------------------------------
// Workspaces, membership, invites
// ---------------------------------------------------------------------------

export const workspaceRole = pgEnum('workspace_role', ROLES);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

/**
 * Invite links are bearer secrets: only the SHA-256 of the token is stored,
 * the raw token is shown once at creation. They always expire and can be
 * capped by use count or revoked.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    role: workspaceRole('role').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invites_token_hash_idx').on(t.tokenHash),
    index('invites_workspace_idx').on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Boards (metadata only; columns and cards live in the board's Yjs document)
// ---------------------------------------------------------------------------

export const boards = pgTable(
  'boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('boards_workspace_idx').on(t.workspaceId)],
);

export type DbWorkspace = typeof workspaces.$inferSelect;
export type DbInvite = typeof invites.$inferSelect;
export type DbBoard = typeof boards.$inferSelect;

// ---------------------------------------------------------------------------
// Board documents (Yjs persistence)
// ---------------------------------------------------------------------------

/**
 * Compacted Yjs state per board: Y.encodeStateAsUpdate of a doc that has had
 * the snapshot plus every pending update applied (with GC on, so deleted
 * content is reduced to tombstone ranges).
 */
export const boardDocuments = pgTable('board_documents', {
  boardId: uuid('board_id')
    .primaryKey()
    .references(() => boards.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  /** How many incremental updates have been folded into this snapshot, ever. */
  compactedUpdates: integer('compacted_updates').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only log of incremental updates received since the last snapshot.
 * Appending is cheap and happens within a few hundred ms of an edit, so a
 * crash between (debounced) snapshots loses nothing. Compaction folds these
 * into board_documents and deletes exactly the rows it folded.
 */
export const boardUpdates = pgTable(
  'board_updates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    userId: uuid('user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('board_updates_board_idx').on(t.boardId, t.id)],
);
