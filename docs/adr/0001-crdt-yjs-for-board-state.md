# ADR 0001: Board state is a Yjs CRDT, synced with Hocuspocus

- Status: accepted
- Date: 2026-10

## Context

Several people edit one board at the same time: they move cards, rename them, type in the same
description, and sometimes work offline and reconnect minutes later. The sync layer has to:

1. Converge. Every replica ends up in the same state no matter what order edits arrive in.
2. Keep intent. Two people typing in one description must both keep their text, and two people
   moving different cards must both see their moves applied.
3. Work offline. An edit made offline is merged when the client reconnects, with no "your
   changes conflict" dialog.
4. Scale to more than one server process (see ADR 0003).

## Options considered

**Last-writer-wins rows (REST + Postgres, maybe with websockets for invalidation).** This is
the simplest option and fine for fields like a card's due date. It fails requirement 2 for text:
with two concurrent description edits, one is silently lost. It also fails requirement 3 unless
we build our own offline queue and conflict resolution, which grows into a hand-rolled CRDT.

**Operational transformation (ShareDB, or a hand-rolled OT).** This is proven for text, but OT
needs a central server to order operations and a transform function for every pair of operation
types. For a kanban model (maps, lists, rich text, moves between lists) that is a lot of
custom correctness-critical code. Long offline sessions are expensive too, because the client
has to transform against everything that happened since. With several servers, ordering also
needs a single sequencer per document.

**CRDT (Yjs).** Updates are commutative, associative and idempotent, so any replica can apply
any update in any order, any number of times, and converge. That gives us offline support
(y-indexeddb), multi-server fan-out (relay updates through Redis, in any order) and
merge-based persistence (ADR 0002) without a sequencer. Yjs is the most mature JS CRDT. It
has bindings for TipTap/ProseMirror, awareness for presence, and Hocuspocus as a server with
auth hooks and a Redis extension.

## Decision

Use Yjs for all board content, with Hocuspocus as the WebSocket server. Postgres holds
only metadata (workspaces, members, board titles) and derived read models (activity, search).

The document model is designed so that concurrent edits merge into states that make sense, not
just states that converge (`packages/shared/src/board/model.ts`):

- **Maps keyed by id, not arrays.** `columns` and `cards` are `Y.Map`s keyed by UUID. Two people
  adding cards never conflict, and deleting a card cannot shift another card's index.
- **Order is a fractional index** (`fractional-indexing` keys) stored on the item, not the
  position in a `Y.Array`. A move is one field write, not delete-plus-insert. With a
  `Y.Array`, two people moving the same card at once would duplicate it, because both
  re-insert it.
- **Position is one atomic field.** A card stores `pos: { columnId, order }` as a single map
  value. If `columnId` and `order` were separate keys, two concurrent moves of the same
  card could merge into a column from one move and an order from the other. As one value,
  LWW-per-key makes the whole move win or lose together. Ties between equal order keys
  are broken by id, so every replica renders the same order.
- **Descriptions are `Y.XmlFragment`** bound to TipTap, so character-level merges work.
  Paragraphs always contain a `Y.XmlText`, even when empty. Without it, two users typing
  into an empty paragraph each create a sibling text node and one character is duplicated
  (`setFragmentText` in `text.ts`, pinned by a unit test).
- **Orphans are tolerated.** If one user deletes a column while another moves a card into it,
  `readBoard` renders the card in the first column instead of losing it.

## Consequences

- Clients can write anything into a CRDT, so authorization cannot be "check the HTTP route".
  The collab server decodes every incoming update at the struct level and rejects
  anything a viewer sends, or that does not match the board schema
  (`validate-update.ts`, ADR 0003 has the permission flow).
- Features that need queries (search, activity log, AI grounding) read derived models or
  decode the persisted document. They see the board as of the last update-log write
  (milliseconds, at most 250ms in a burst) or the last compaction (search: at most 10s).
- Tombstones grow with history. Compaction with GC enabled drops deleted content, so this
  is bounded (ADR 0002).
- Undo across users and "who wrote this" for text are harder than with OT plus an
  operation log. The activity log reconstructs intent from transactions instead
  (`activity.ts`).
