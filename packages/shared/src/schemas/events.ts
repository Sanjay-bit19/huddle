import { z } from 'zod';

/**
 * Control-plane events the API publishes on Redis for the collab servers.
 * They let HTTP-side changes (logout, role change, deletion) take effect on
 * already-open WebSockets instead of waiting for the next reconnect.
 */
export const SERVER_EVENTS_CHANNEL = 'huddle:server-events';

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sessions-revoked'),
    userId: z.uuid(),
    /** Omitted = every session of the user ("log out everywhere"). */
    sessionIds: z.array(z.uuid()).optional(),
  }),
  z.object({
    type: z.literal('membership-changed'),
    workspaceId: z.uuid(),
    userId: z.uuid(),
  }),
  z.object({
    type: z.literal('board-deleted'),
    boardId: z.uuid(),
  }),
  z.object({
    type: z.literal('board-broadcast'),
    boardId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
