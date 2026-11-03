import type {
  Extension,
  onAuthenticatePayload,
  onConnectPayload,
  onDisconnectPayload,
} from '@hocuspocus/server';
import { getBoardAccess, isSessionLive, type Database } from '@huddle/db';
import { can, COLLAB_REASONS, parseBoardDocumentName } from '@huddle/shared';
import { verifyAccessToken } from '@huddle/shared/server';
import type { Logger } from 'pino';
import type { CollabContext } from '../context';
import type { CollabMetrics } from '../metrics';

/** Error shape Hocuspocus understands: `reason` is sent to the provider. */
export class CollabError extends Error {
  constructor(
    public readonly reason: string,
    public readonly code = 4403,
  ) {
    super(reason);
  }
}

/**
 * Authenticates every document connection: verifies the JWT, confirms the
 * session is still live (logout / reuse detection apply here too), and looks
 * up the caller's role for the board's workspace. Viewers get a read-only
 * connection: Hocuspocus drops their sync writes and answers with a negative
 * sync status, so they still receive every update but cannot change the doc.
 */
export function authExtension(deps: {
  db: Database;
  jwtSecret: string;
  logger: Logger;
  metrics: CollabMetrics;
}): Extension {
  const { db, jwtSecret, logger, metrics } = deps;

  const fail = (reason: string, details: Record<string, unknown>): never => {
    metrics.authFailures.inc({ reason });
    logger.warn({ ...details, reason }, 'websocket auth failed');
    throw new CollabError(reason, reason === COLLAB_REASONS.unauthorized ? 4401 : 4403);
  };

  return {
    extensionName: 'huddle-auth',

    async onConnect({ socketId, request }: onConnectPayload) {
      logger.debug(
        { connId: socketId, requestId: request.headers.get('x-request-id') },
        'socket connected',
      );
    },

    async onAuthenticate(data: onAuthenticatePayload): Promise<CollabContext> {
      const { token, documentName, socketId, connectionConfig } = data;
      const boardId = parseBoardDocumentName(documentName);
      if (!boardId) return fail(COLLAB_REASONS.forbidden, { connId: socketId, documentName });

      let claims;
      try {
        claims = await verifyAccessToken(token, jwtSecret);
      } catch {
        return fail(COLLAB_REASONS.unauthorized, { connId: socketId, boardId });
      }
      if (!(await isSessionLive(db, claims.sid, claims.sub))) {
        return fail(COLLAB_REASONS.sessionRevoked, { connId: socketId, userId: claims.sub });
      }
      const access = await getBoardAccess(db, claims.sub, boardId);
      if (!access?.role) {
        return fail(COLLAB_REASONS.forbidden, { connId: socketId, userId: claims.sub, boardId });
      }

      connectionConfig.readOnly = !can(access.role, 'board:write');
      logger.info(
        {
          connId: socketId,
          userId: claims.sub,
          boardId,
          role: access.role,
          readOnly: connectionConfig.readOnly,
        },
        'socket authenticated',
      );
      return {
        userId: claims.sub,
        name: claims.name,
        sessionId: claims.sid,
        boardId,
        workspaceId: access.workspaceId,
        role: access.role,
        connId: socketId,
      };
    },

    async onDisconnect({ socketId, context, clientsCount }: onDisconnectPayload<CollabContext>) {
      logger.info(
        { connId: socketId, userId: context?.userId, boardId: context?.boardId, clientsCount },
        'socket disconnected',
      );
    },
  };
}
