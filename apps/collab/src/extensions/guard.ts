import type {
  beforeHandleAwarenessPayload,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  Extension,
  onChangePayload,
} from '@hocuspocus/server';
import { isTransactionOrigin } from '@hocuspocus/server';
import { awarenessStateSchema, COLLAB_REASONS, userColor } from '@huddle/shared';
import { validateBoardUpdate } from '@huddle/shared/board';
import type { Logger } from 'pino';
import type { CollabContext } from '../context';
import type { CollabMetrics } from '../metrics';
import { CollabError } from './auth';

// y-protocols sync message subtypes
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

/**
 * Server-authoritative checks on every WebSocket message after auth:
 *  - writes: shape/size-validated (Zod) before they are applied; viewers'
 *    writes are counted and refused (Hocuspocus does the refusal itself
 *    because the connection is read-only)
 *  - awareness: validated and re-stamped with the authenticated identity
 */
export function guardExtension(deps: { logger: Logger; metrics: CollabMetrics }): Extension {
  const { logger, metrics } = deps;

  return {
    extensionName: 'huddle-guard',

    async beforeHandleMessage(_data: beforeHandleMessagePayload) {
      metrics.messagesReceived.inc();
    },

    async beforeSync({ connection, type, payload, document }: beforeSyncPayload<CollabContext>) {
      if (type !== SYNC_STEP_2 && type !== SYNC_UPDATE) return;
      const ctx = connection.context;

      if (connection.readOnly) {
        // Hocuspocus will not apply it; we only record the attempt. A step-2
        // during the initial handshake is normal (usually empty), so only
        // explicit incremental updates count as rejected writes.
        if (type === SYNC_UPDATE) {
          metrics.rejectedWrites.inc({ reason: 'read_only' });
          logger.warn(
            {
              connId: ctx.connId,
              userId: ctx.userId,
              boardId: ctx.boardId,
              bytes: payload.byteLength,
            },
            'write from read-only connection rejected',
          );
        }
        return;
      }

      const result = validateBoardUpdate(payload, document);
      if (!result.ok) {
        metrics.rejectedWrites.inc({ reason: 'invalid' });
        logger.warn(
          { connId: ctx.connId, userId: ctx.userId, boardId: ctx.boardId, reason: result.reason },
          'invalid update rejected',
        );
        // Throwing closes this document connection without applying anything.
        throw new CollabError(COLLAB_REASONS.invalidUpdate, 4400);
      }
    },

    async beforeHandleAwareness({ states, context }: beforeHandleAwarenessPayload<CollabContext>) {
      if (!context) return; // server-internal (Redis relay): already validated at the edge
      for (const [clientId, state] of states) {
        if (Object.keys(state).length === 0) continue; // explicit "left" marker
        const parsed = awarenessStateSchema.safeParse({
          ...state,
          // Identity comes from the verified token, never from the client.
          user: { id: context.userId, name: context.name, color: userColor(context.userId) },
        });
        if (!parsed.success) {
          states.delete(clientId);
          continue;
        }
        // Replace in place with the sanitized object (unknown keys stripped).
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, parsed.data);
      }
    },

    async onChange({ transactionOrigin, clientsCount }: onChangePayload) {
      const origin = isTransactionOrigin(transactionOrigin) ? transactionOrigin.source : 'unknown';
      metrics.updatesApplied.inc({ origin });
      metrics.updatesBroadcast.inc(clientsCount);
    },
  };
}
