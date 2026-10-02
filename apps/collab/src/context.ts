import type { Role } from '@huddle/shared';

/** Per-connection context, established by the auth extension. */
export interface CollabContext {
  userId: string;
  name: string;
  sessionId: string;
  boardId: string;
  workspaceId: string;
  role: Role;
  /** Correlates log lines for one socket (Hocuspocus socketId). */
  connId: string;
}
