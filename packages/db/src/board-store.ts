import { asc, eq, inArray, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Database } from './client';
import { boardDocuments, boardUpdates } from './schema';

/**
 * Board document persistence: snapshot + append-only update log.
 *
 *   write path:  every client update -> boardUpdates (immediately when quiet,
 *                batched per ~250ms window during bursts)
 *   compaction:  debounced -> fold snapshot + log (+ in-memory doc) into a
 *                new snapshot, delete exactly the log rows that were folded
 *   load path:   snapshot + all remaining log rows
 *
 * All three are safe under concurrency because Yjs updates are idempotent
 * and commutative: applying an update twice, or in any order, converges to
 * the same state. That is what lets two collab instances compact the same
 * board without coordinating beyond a row lock.
 */

export interface LoadedBoardState {
  /** Snapshot merged with pending updates; null if the board has no document yet. */
  state: Uint8Array | null;
  pendingUpdates: number;
}

export async function loadBoardState(db: Database, boardId: string): Promise<LoadedBoardState> {
  const [snapshot] = await db
    .select({ state: boardDocuments.state })
    .from(boardDocuments)
    .where(eq(boardDocuments.boardId, boardId));
  const pending = await db
    .select({ update: boardUpdates.update })
    .from(boardUpdates)
    .where(eq(boardUpdates.boardId, boardId))
    .orderBy(asc(boardUpdates.id));
  const parts = [...(snapshot ? [snapshot.state] : []), ...pending.map((p) => p.update)];
  if (parts.length === 0) return { state: null, pendingUpdates: 0 };
  return { state: Y.mergeUpdates(parts), pendingUpdates: pending.length };
}

/** Loads the board into a fresh Y.Doc (used by the API for AI grounding and search). */
export async function loadBoardDoc(db: Database, boardId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const { state } = await loadBoardState(db, boardId);
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

export async function appendBoardUpdates(
  db: Database,
  rows: Array<{ boardId: string; update: Uint8Array; userId: string | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(boardUpdates).values(rows);
}

/** Creates the initial snapshot for a new board (idempotent). */
export async function initBoardDocument(
  db: Pick<Database, 'insert'>,
  boardId: string,
  state: Uint8Array,
): Promise<void> {
  await db.insert(boardDocuments).values({ boardId, state }).onConflictDoNothing();
}

export interface CompactionResult {
  foldedUpdates: number;
  snapshotBytes: number;
}

/**
 * Folds the update log into the snapshot. `inMemory` is the live document's
 * full state from the collab server, if any, so the snapshot is never older
 * than what clients have already seen acknowledged.
 */
export async function compactBoard(
  db: Database,
  boardId: string,
  inMemory?: Uint8Array,
): Promise<CompactionResult> {
  return db.transaction(async (tx) => {
    // Lock the snapshot row: concurrent compactions of one board serialize.
    const [snapshot] = await tx
      .select({ state: boardDocuments.state })
      .from(boardDocuments)
      .where(eq(boardDocuments.boardId, boardId))
      .for('update');
    const pending = await tx
      .select({ id: boardUpdates.id, update: boardUpdates.update })
      .from(boardUpdates)
      .where(eq(boardUpdates.boardId, boardId))
      .orderBy(asc(boardUpdates.id));

    // Apply everything to a GC-enabled doc and re-encode. Unlike
    // Y.mergeUpdates (which only concatenates structs), this drops the
    // content of deleted items, so snapshots do not grow with churn.
    const doc = new Y.Doc({ gc: true });
    if (snapshot) Y.applyUpdate(doc, snapshot.state);
    for (const p of pending) Y.applyUpdate(doc, p.update);
    if (inMemory) Y.applyUpdate(doc, inMemory);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    await tx
      .insert(boardDocuments)
      .values({ boardId, state, compactedUpdates: pending.length })
      .onConflictDoUpdate({
        target: boardDocuments.boardId,
        set: {
          state,
          compactedUpdates: sql`${boardDocuments.compactedUpdates} + ${pending.length}`,
          updatedAt: new Date(),
        },
      });
    // Delete exactly the rows we folded. Rows appended after our SELECT keep
    // living in the log and are picked up by the next compaction or load.
    if (pending.length > 0) {
      await tx.delete(boardUpdates).where(
        inArray(
          boardUpdates.id,
          pending.map((p) => p.id),
        ),
      );
    }
    return { foldedUpdates: pending.length, snapshotBytes: state.byteLength };
  });
}
