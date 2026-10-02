import { z } from 'zod';

/**
 * Awareness (presence) state each client publishes. The collab server
 * re-validates it on every update and overwrites `user` with the identity from
 * the verified token, so nobody can appear on a board as someone else.
 */
export const presenceUserSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(80),
  color: z.string().max(16),
});

export const awarenessStateSchema = z.object({
  user: presenceUserSchema,
  /** Mouse pointer in board-content coordinates (scroll-independent). */
  pointer: z
    .object({
      x: z.number().finite().min(-1e5).max(1e6),
      y: z.number().finite().min(-1e5).max(1e6),
    })
    .nullable()
    .optional(),
  /**
   * Text caret inside a card description, written by the TipTap collaboration
   * caret plugin as Yjs relative positions. Opaque to us; only size-bounded.
   */
  cursor: z
    .object({ anchor: z.unknown(), head: z.unknown() })
    .nullable()
    .optional()
    .refine((v) => v == null || JSON.stringify(v).length <= 1024, 'cursor too large'),
  /** Card whose detail panel this user has open for editing. */
  editingCardId: z.string().max(128).nullable().optional(),
  /** Card currently being dragged by this user. */
  draggingCardId: z.string().max(128).nullable().optional(),
});
export type AwarenessState = z.infer<typeof awarenessStateSchema>;
export type PresenceUser = z.infer<typeof presenceUserSchema>;

const PALETTE = [
  '#ef4444',
  '#f97316',
  '#d97706',
  '#16a34a',
  '#0d9488',
  '#0284c7',
  '#4f46e5',
  '#9333ea',
  '#db2777',
];

/** Deterministic per-user color so a person looks the same to everyone. */
export function userColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** Stateless messages the server pushes to clients on a board. */
export const boardStatelessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role-changed'), role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']) }),
  z.object({ kind: z.literal('board-meta-changed') }),
  z.object({ kind: z.literal('comments-changed'), cardId: z.string() }),
  z.object({ kind: z.literal('activity') }),
]);
export type BoardStateless = z.infer<typeof boardStatelessSchema>;

/** WebSocket close / permission-denied reasons shared by server and client. */
export const COLLAB_REASONS = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  sessionRevoked: 'session-revoked',
  accessRevoked: 'access-revoked',
  boardDeleted: 'board-deleted',
  invalidUpdate: 'invalid-update',
} as const;

export const boardDocumentName = (boardId: string) => `board:${boardId}`;
export function parseBoardDocumentName(name: string): string | null {
  const m = /^board:([0-9a-f-]{36})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}
