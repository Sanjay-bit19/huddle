# ADR 0003: Scale the collab tier horizontally through Redis, without sticky sessions

- Status: accepted
- Date: 2026-10

## Context

One Node process holds every open board in memory and owns every socket for it. To survive
a node restart and to grow past one machine, we need at least two collab instances. The
question is how clients editing the same board on different instances see each other.

## Options considered

**Sticky routing by board (consistent hashing on the document name).** All clients of a
board land on one node, so there is no cross-node sync. But the load balancer has to parse
the document name (it is inside the WebSocket messages, not the URL, in Hocuspocus's
multiplexed protocol), rebalancing moves boards around, and a hot board is limited to one
node. Fly's proxy, like most managed load balancers, cannot route on message content.

**A dedicated per-board leader with forwarding.** This is the OT-style answer. It needs
leader election and adds a hop for followers. A CRDT does not need it.

**Every node can serve every board; nodes relay updates through Redis pub/sub.** Yjs updates
can be applied in any order, more than once (ADR 0001), so an at-most-once, unordered
broadcast bus is enough as long as nodes can repair gaps.

## Decision

Use `@hocuspocus/extension-redis` (`apps/collab/src/server.ts`) with plain round-robin load
balancing:

- **Fan-out.** When a node applies an update from one of its clients, it publishes it on the
  document's Redis channel. Every other node that has the board loaded applies it and sends
  it to its own clients.
- **Anti-entropy instead of reliable delivery.** When a node loads a board it publishes a
  sync step 1 (its state vector), and peers answer with what it is missing. Awareness
  (presence) is relayed the same way. A lost pub/sub message is repaired at the next sync
  exchange.
- **One compactor at a time.** The extension takes a Redlock lock around
  `onStoreDocument`, so normally one node compacts a board. If the lock lapses, two
  compactions are still safe (ADR 0002).
- **Control plane on a separate channel** (`huddle:server-events`, `control-events.ts`).
  The API publishes `sessions-revoked`, `membership-changed` and `board-deleted`. Every node
  acts on its local sockets: it closes revoked sessions, flips `connection.readOnly` when a
  role changes (a demoted editor's next write is rejected without reconnecting), and drops
  deleted boards. Stateless board messages (`board-broadcast`) use the same path.

Permissions are enforced on the node that holds the socket, on every message, not at the
edge:

- The auth hook verifies the JWT, checks that the session is still live and that the user can
  access the board, and sets `readOnly` for viewers.
- `beforeSync` decodes each incoming update and rejects writes from read-only connections,
  as well as structurally invalid updates.
- Awareness states are re-stamped with the authenticated user id, so a client cannot
  impersonate someone in presence.

## Consequences

- No sticky sessions: any LB (Fly proxy, nginx `round_robin`, the dev
  `scripts/collab-lb.mjs`) works, and a node can be drained or killed without moving board
  ownership. Clients reconnect with backoff and resync by state vector.
- Each board is held in memory on every node that has a client for it. Memory scales with
  open boards × nodes serving them, which is fine at this size. At large scale you would add
  board-affinity routing as an optimization, not for correctness.
- Redis is in the hot path. A Redis outage splits the cluster: each node keeps serving its
  own clients consistently, and they converge when Redis returns (anti-entropy on
  re-subscribe). Single-node correctness never depends on Redis.
- Verified by integration tests against real Redis and Postgres:
  - `scaling.int.test.ts` runs two in-process servers sharing Redis. It checks that
    concurrent bursts converge to identical documents (compared by state vector), that a
    late joiner gets unpersisted state from its peer, that presence crosses nodes, and that
    control events reach sockets on every node.
  - `permissions.int.test.ts` checks that a demoted editor becomes read-only on the open
    socket, that a removed member is disconnected, and that "log out everywhere" closes only
    that user's sockets.
- The k6 run with 200 clients split across two nodes delivered every update to every client,
  with 0 drops (README).
