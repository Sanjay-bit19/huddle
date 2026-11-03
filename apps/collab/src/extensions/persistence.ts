import type {
  afterUnloadDocumentPayload,
  Extension,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import { isTransactionOrigin } from '@hocuspocus/server';
import {
  appendBoardUpdates,
  compactBoard,
  loadBoardState,
  syncCardSearch,
  type CardHashes,
  type Database,
} from '@huddle/db';
import { parseBoardDocumentName } from '@huddle/shared';
import { createSeedUpdate, readBoard } from '@huddle/shared/board';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import type { CollabContext } from '../context';
import type { CollabMetrics } from '../metrics';
import { captureError } from '../observability';

interface PendingRow {
  boardId: string;
  update: Uint8Array;
  userId: string | null;
}

/**
 * Two-tier persistence (see packages/db/src/board-store.ts):
 *
 * 1. Every update a client sends to THIS node is appended to the update log:
 *    immediately after a quiet period, batched per UPDATE_LOG_FLUSH_MS window
 *    during bursts. Updates relayed from other nodes via Redis
 *    are skipped: the node that received them from the client logs them.
 * 2. Hocuspocus calls onStoreDocument debounced (2s, max 10s), and we fold the
 *    log plus the in-memory doc into a compacted snapshot. With the Redis
 *    extension installed, a Redlock ensures only one node compacts a given
 *    board at a time; compaction is merge-based so even an overlap is safe.
 */
export function persistenceExtension(deps: {
  db: Database;
  logger: Logger;
  metrics: CollabMetrics;
  flushMs: number;
}): Extension & { flushAll(): Promise<void> } {
  const { db, logger, metrics, flushMs } = deps;
  const pending = new Map<string, PendingRow[]>();
  const timers = new Map<string, NodeJS.Timeout>();
  // Per board: hash of each card as last written to the search index, so a
  // compaction only rewrites the rows that changed.
  const searchHashes = new Map<string, CardHashes>();

  /** Writes the board's buffered rows now and ends its batching window. */
  async function flush(boardId: string): Promise<void> {
    const timer = timers.get(boardId);
    if (timer) clearTimeout(timer);
    timers.delete(boardId);
    await write(boardId);
  }

  /**
   * Throttle with a leading edge: the first update after a quiet period is
   * written immediately, so readers of the log (the API's AI grounding) see a
   * lone edit within milliseconds. Updates arriving during the following
   * flushMs window are batched into one insert at its end, and the window
   * stays open while updates keep coming (one insert per window under load).
   */
  function openWindow(boardId: string) {
    timers.set(
      boardId,
      setTimeout(() => {
        timers.delete(boardId);
        if (pending.get(boardId)?.length) {
          openWindow(boardId);
          void write(boardId);
        }
      }, flushMs),
    );
  }

  async function write(boardId: string): Promise<void> {
    const rows = pending.get(boardId);
    if (!rows?.length) return;
    pending.delete(boardId);
    try {
      await appendBoardUpdates(db, rows);
      metrics.updateLogWrites.inc(rows.length);
    } catch (err) {
      // Typically the board was deleted (FK violation). If not, the updates
      // are still in memory and will be part of the next snapshot.
      logger.error({ err, boardId, rows: rows.length }, 'failed to append update log');
      captureError(err, { boardId, op: 'append-update-log' });
    }
  }

  const ext = {
    extensionName: 'huddle-persistence',

    async onLoadDocument({ documentName, document, socketId }: onLoadDocumentPayload) {
      const boardId = parseBoardDocumentName(documentName);
      if (!boardId) throw new Error(`invalid document name ${documentName}`);
      const started = performance.now();
      const { state, pendingUpdates } = await loadBoardState(db, boardId);
      // Applied before Hocuspocus attaches its update listener, so hydration
      // is not echoed back into the update log.
      Y.applyUpdate(document, state ?? createSeedUpdate(boardId));
      logger.info(
        {
          connId: socketId,
          boardId,
          pendingUpdates,
          bytes: state?.byteLength ?? 0,
          ms: Math.round(performance.now() - started),
        },
        'document hydrated',
      );
    },

    async onChange({
      documentName,
      update,
      transactionOrigin,
      context,
    }: onChangePayload<CollabContext>) {
      if (!isTransactionOrigin(transactionOrigin) || transactionOrigin.source !== 'connection')
        return;
      const boardId = parseBoardDocumentName(documentName);
      if (!boardId) return;
      const rows = pending.get(boardId) ?? [];
      rows.push({ boardId, update, userId: context?.userId ?? null });
      pending.set(boardId, rows);
      if (flushMs === 0) {
        await flush(boardId);
      } else if (!timers.has(boardId)) {
        openWindow(boardId);
        void write(boardId);
      }
    },

    async onStoreDocument({ documentName, document }: onStoreDocumentPayload) {
      const boardId = parseBoardDocumentName(documentName);
      if (!boardId) return;
      await flush(boardId);
      const end = metrics.compactionSeconds.startTimer();
      try {
        const result = await compactBoard(db, boardId, Y.encodeStateAsUpdate(document));
        metrics.snapshotBytes.observe(result.snapshotBytes);
        logger.debug({ boardId, ...result }, 'document compacted');
        // Search is a read model of the document, refreshed on the same
        // cadence as snapshots (so it lags edits by at most maxDebounce).
        searchHashes.set(
          boardId,
          await syncCardSearch(db, boardId, readBoard(document), searchHashes.get(boardId)),
        );
      } catch (err) {
        logger.error({ err, boardId }, 'compaction failed');
        captureError(err, { boardId, op: 'compaction' });
        throw err;
      } finally {
        end();
      }
    },

    async afterUnloadDocument({ documentName }: afterUnloadDocumentPayload) {
      const boardId = parseBoardDocumentName(documentName);
      if (boardId) {
        await flush(boardId);
        searchHashes.delete(boardId);
      }
    },

    async onDestroy() {
      await ext.flushAll();
    },

    async flushAll() {
      await Promise.all([...pending.keys()].map((id) => flush(id)));
    },
  };
  return ext;
}
