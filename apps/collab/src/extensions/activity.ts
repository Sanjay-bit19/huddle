import type {
  afterLoadDocumentPayload,
  afterUnloadDocumentPayload,
  Extension,
  Hocuspocus,
  onConfigurePayload,
} from '@hocuspocus/server';
import { isTransactionOrigin } from '@hocuspocus/server';
import { activityEvents, type Database } from '@huddle/db';
import { boardDocumentName, parseBoardDocumentName, type BoardStateless } from '@huddle/shared';
import { ActivityTracker, type ActivityItem } from '@huddle/shared/board';
import type { Logger } from 'pino';
import type * as Y from 'yjs';
import type { CollabContext } from '../context';
import type { CollabMetrics } from '../metrics';
import { captureError } from '../observability';

/** Rich-text typing produces an event per keystroke; log at most one per window. */
const DESCRIPTION_COALESCE_MS = 5 * 60_000;

interface Row {
  boardId: string;
  actorId: string;
  item: ActivityItem;
}

/**
 * Records the activity log. For each document it keeps an ActivityTracker and
 * listens to transactions; only transactions whose origin is a client
 * connection on THIS node are recorded (Redis-relayed copies are skipped), so
 * across a cluster every change is logged exactly once, attributed to the
 * authenticated user who made it.
 */
export function activityExtension(deps: {
  db: Database;
  logger: Logger;
  metrics: CollabMetrics;
  flushMs?: number;
}): Extension & { flushAll(): Promise<void> } {
  const { db, logger, metrics } = deps;
  const flushMs = deps.flushMs ?? 500;
  const detach = new Map<string, () => void>();
  const buffer: Row[] = [];
  const lastDescriptionEdit = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let instance: Hocuspocus | null = null;

  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buffer.length === 0) return;
    const rows = buffer.splice(0, buffer.length);
    try {
      await db.insert(activityEvents).values(
        rows.map((r) => ({
          boardId: r.boardId,
          actorId: r.actorId,
          type: r.item.type,
          cardId: r.item.cardId,
          data: r.item.data,
        })),
      );
      rows.forEach((r) => metrics.activityEvents.inc({ type: r.item.type }));
      // Nudge open clients (on every node, via Redis) to refresh their feed.
      const msg: BoardStateless = { kind: 'activity' };
      for (const boardId of new Set(rows.map((r) => r.boardId))) {
        instance?.documents
          .get(boardDocumentName(boardId))
          ?.broadcastStateless(JSON.stringify(msg));
      }
    } catch (err) {
      logger.error({ err, rows: rows.length }, 'failed to record activity');
      captureError(err, { op: 'activity' });
    }
  }

  const ext = {
    extensionName: 'huddle-activity',

    async onConfigure({ instance: i }: onConfigurePayload) {
      instance = i;
    },

    async afterLoadDocument({ documentName, document }: afterLoadDocumentPayload) {
      const boardId = parseBoardDocumentName(documentName);
      if (!boardId) return;
      const tracker = new ActivityTracker(document);
      const onTransaction = (tr: Y.Transaction) => {
        const origin = tr.origin;
        if (isTransactionOrigin(origin) && origin.source === 'connection') {
          const ctx = origin.connection.context as CollabContext | undefined;
          if (ctx) {
            for (const item of tracker.derive(tr)) {
              if (item.type === 'card.description_edited') {
                const key = `${ctx.userId}:${item.cardId}`;
                const last = lastDescriptionEdit.get(key) ?? 0;
                if (Date.now() - last < DESCRIPTION_COALESCE_MS) continue;
                lastDescriptionEdit.set(key, Date.now());
              }
              buffer.push({ boardId, actorId: ctx.userId, item });
            }
            if (buffer.length && !timer) timer = setTimeout(() => void flush(), flushMs);
          }
        }
        // Remember titles as of now, for describing the next change.
        tracker.refresh();
      };
      document.on('afterTransaction', onTransaction);
      detach.set(documentName, () => document.off('afterTransaction', onTransaction));
    },

    async afterUnloadDocument({ documentName }: afterUnloadDocumentPayload) {
      detach.get(documentName)?.();
      detach.delete(documentName);
      await flush();
    },

    async onDestroy() {
      await flush();
    },

    flushAll: flush,
  };
  return ext;
}
