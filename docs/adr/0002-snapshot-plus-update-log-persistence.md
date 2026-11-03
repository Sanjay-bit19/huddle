# ADR 0002: Persistence is a snapshot plus an append-only update log, compacted by merging

- Status: accepted
- Date: 2026-10

## Context

Hocuspocus keeps each open board in memory and calls `onStoreDocument` debounced (we use 2s,
at most 10s). The default pattern is to write the full document state on that hook. That
has two problems:

1. **Durability window.** A process crash loses up to 10s of acknowledged edits. Clients
   usually still have them (and y-indexeddb keeps them), but a client that never comes back
   (a closed tab with IndexedDB cleared) means data loss.
2. **Write amplification.** Rewriting the full state for every burst of edits costs about the
   document size per store, however small the change.

With several collab instances (ADR 0003), two nodes can also hold the same board in
memory and both store it.

## Decision

Two tiers (`packages/db/src/board-store.ts`, `apps/collab/src/extensions/persistence.ts`):

- **Update log (`board_updates`).** Every update a client sends to a node is appended.
  The write is throttled with a leading edge: the first update after a quiet period is
  inserted immediately, and a burst is batched into one insert per 250ms window
  (`UPDATE_LOG_FLUSH_MS`). Only the node that received the update from a
  client writes it. Updates relayed from another node via Redis are skipped, so each edit is
  logged once. Rows record the author's user id.
- **Snapshot (`board_documents`).** On the debounced store hook, `compactBoard` runs in one
  transaction:
  1. `SELECT ... FOR UPDATE` the snapshot row, so compactions of one board serialize.
  2. Read all log rows for the board.
  3. Apply snapshot + rows + the node's in-memory state to a fresh **GC-enabled** `Y.Doc`
     and encode it.
  4. Upsert the snapshot and delete **exactly the row ids that were read**. Rows appended
     during the compaction stay for the next pass.
- **Load** = snapshot merged with every remaining log row (`Y.mergeUpdates`).

This is correct without further coordination because Yjs updates are idempotent and
commutative:

- An update in both the snapshot and the log is applied twice, which is harmless.
- Two nodes compacting the same board serialize on the row lock. Even if they didn't, each
  result is a superset of what it deleted.
- Because a row is only deleted after it was folded in, the log plus snapshot is never missing
  an update: it is either still in the log or already in the snapshot.

**Why apply into a GC'd doc instead of `Y.mergeUpdates`?** `mergeUpdates` concatenates structs
and keeps the content of deleted items, so a snapshot of a board where someone pasted and
deleted a long text keeps that text forever. Applying into a `Y.Doc({ gc: true })` and
re-encoding replaces deleted content with GC structs, so snapshot size follows live content
plus small tombstones. Clients keep their own history (y-indexeddb) and still sync, because
GC'd structs remain valid for the state-vector diff.

**Read models ride on compaction.** The search index (`card_search`) is refreshed in the same
store hook. Card hashes mean only changed cards are rewritten, so search lags edits by at most
the 10s max debounce. The API's AI features read snapshot + log directly. On a quiet board they see an edit within milliseconds, and during a burst they are
behind by at most one 250ms window. The first version used a plain trailing 250ms buffer.
A screenshot from the e2e run showed a summary that missed a card added just before clicking
Summarize. That is why the write now has a leading edge, and the AI e2e test now asserts
that the summary counts that card.

## Consequences

- The durability window for acknowledged edits drops from about 10s to at most one 250ms
  batching window.
- Writes per edit burst are proportional to the edit, not the document. Compaction cost
  shows up in `collab_compaction_duration_seconds` and snapshot size in
  `collab_snapshot_bytes`.
- Log rows for an idle board are compacted the next time it is opened and stored. A board
  that is never reopened keeps its last few log rows. That is correct, and could be
  cleaned up by a periodic job.
- Integration tests (`apps/collab/test/persistence.int.test.ts`) cover:
  - hydration from snapshot plus never-compacted updates
  - a restarted node rebuilding the board from snapshot plus pending log
  - concurrent and repeated compaction being safe
  - GC dropping deleted content
- `scaling.int.test.ts` checks that each update is logged exactly once by the node that
  received it.
