import type { Connection, Hocuspocus } from '@hocuspocus/server';
import { getWorkspaceRole, type Database } from '@huddle/db';
import {
  can,
  COLLAB_REASONS,
  SERVER_EVENTS_CHANNEL,
  boardDocumentName,
  serverEventSchema,
  type BoardStateless,
  type ServerEvent,
} from '@huddle/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { CollabContext } from './context';

/**
 * Applies HTTP-side changes to sockets that are already open: logout,
 * role changes and deletions take effect immediately, on every node, instead
 * of at the next reconnect.
 */
export function subscribeToControlEvents(deps: {
  redisUrl: string;
  hocuspocus: Hocuspocus;
  db: Database;
  logger: Logger;
}): { close: () => Promise<void>; ready: Promise<void> } {
  const { hocuspocus, db, logger } = deps;
  const sub = new Redis(deps.redisUrl);
  sub.on('error', (err) => logger.error({ err }, 'control-event subscriber error'));

  const allConnections = function* (): Generator<[Connection<CollabContext>, string]> {
    for (const [name, document] of hocuspocus.documents) {
      for (const connection of document.getConnections()) {
        yield [connection as Connection<CollabContext>, name];
      }
    }
  };

  const close = (connection: Connection<CollabContext>, reason: string, code: number) => {
    logger.info(
      { connId: connection.context?.connId, userId: connection.context?.userId, reason },
      'closing connection after control event',
    );
    connection.close({ code, reason });
  };

  async function handle(event: ServerEvent) {
    switch (event.type) {
      case 'sessions-revoked': {
        for (const [connection] of allConnections()) {
          const ctx = connection.context;
          if (ctx?.userId !== event.userId) continue;
          if (event.sessionIds && !event.sessionIds.includes(ctx.sessionId)) continue;
          close(connection, COLLAB_REASONS.sessionRevoked, 4401);
        }
        break;
      }
      case 'membership-changed': {
        const affected = [...allConnections()].filter(
          ([c]) =>
            c.context?.userId === event.userId && c.context.workspaceId === event.workspaceId,
        );
        if (affected.length === 0) break;
        const role = await getWorkspaceRole(db, event.userId, event.workspaceId);
        for (const [connection] of affected) {
          if (!role) {
            close(connection, COLLAB_REASONS.accessRevoked, 4403);
            continue;
          }
          // Flip write access on the live connection; Hocuspocus consults
          // `readOnly` on every incoming sync message.
          connection.readOnly = !can(role, 'board:write');
          connection.context.role = role;
          const msg: BoardStateless = { kind: 'role-changed', role };
          connection.sendStateless(JSON.stringify(msg));
        }
        break;
      }
      case 'board-deleted': {
        const document = hocuspocus.documents.get(boardDocumentName(event.boardId));
        for (const connection of document?.getConnections() ?? []) {
          close(connection as Connection<CollabContext>, COLLAB_REASONS.boardDeleted, 4404);
        }
        break;
      }
      case 'board-broadcast': {
        const document = hocuspocus.documents.get(boardDocumentName(event.boardId));
        // Local sockets only: every node receives this event from Redis itself.
        for (const connection of document?.getConnections() ?? []) {
          connection.sendStateless(JSON.stringify(event.payload));
        }
        break;
      }
    }
  }

  sub.on('message', (_channel, raw) => {
    let event: ServerEvent;
    try {
      event = serverEventSchema.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err }, 'ignoring malformed control event');
      return;
    }
    handle(event).catch((err) => logger.error({ err, event }, 'control event failed'));
  });

  const ready = sub.subscribe(SERVER_EVENTS_CHANNEL).then(() => undefined);
  return {
    ready,
    close: async () => {
      await sub.quit().catch(() => undefined);
    },
  };
}
