// k6 WebSocket fan-out test for the collab server.
//
// N virtual users open a WebSocket each to the same board, authenticate and
// run the Yjs sync handshake exactly like the browser provider does. A few
// "writer" VUs then add cards whose titles embed a send timestamp; every other
// client records how long each update took to reach it (fan-out latency) and
// counts deliveries, so dropped messages = expected - received.
//
// Bundled with esbuild (Yjs + the shared board model run inside k6):
//   pnpm load:build && k6 run load/dist/ws-fanout.js
import { WebSocket } from 'k6/websockets';
import { setInterval, setTimeout, clearInterval } from 'k6/timers';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Gauge, Trend } from 'k6/metrics';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { addCard } from '../packages/shared/src/board/model.ts';

const target = JSON.parse(open('../results/target.json'));
const VUS = Number(__ENV.VUS || 200);
const WRITERS = Number(__ENV.WRITERS || 5);
const WRITE_HZ = Number(__ENV.WRITE_HZ || 2); // per writer
const CONNECT_S = Number(__ENV.CONNECT_S || 20);
const WRITE_S = Number(__ENV.WRITE_S || 30);
const DRAIN_S = Number(__ENV.DRAIN_S || 5);
const LABEL = __ENV.LABEL || 'run';
// HEARTBEAT=0 reproduces the idle-timeout disconnects found while building this test.
const HEARTBEAT = __ENV.HEARTBEAT !== '0';

// Hocuspocus message types / sub-types
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;
const MSG_SYNC_REPLY = 4;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const AUTH_TOKEN = 0;
const AUTH_DENIED = 1;
const AUTH_OK = 2;

const fanoutLatency = new Trend('fanout_latency', true);
const syncTime = new Trend('time_to_sync', true);
const probesSent = new Counter('probes_sent');
const probesReceived = new Counter('probes_received');
const clientsSynced = new Counter('clients_synced');
const authFailures = new Counter('auth_failures');
const wsErrors = new Counter('ws_errors');
const unexpectedCloses = new Counter('unexpected_closes');
const rssIdle = new Gauge('collab_rss_idle_bytes');
const rssLoaded = new Gauge('collab_rss_loaded_bytes');
const heapIdle = new Gauge('collab_heap_idle_bytes');
const heapLoaded = new Gauge('collab_heap_loaded_bytes');
const connectionsLoaded = new Gauge('collab_connections_loaded');
const heapMeasuredAfterGc = new Gauge('heap_measured_after_gc');
const receivedPerClient = new Trend('received_per_client');
const lateSyncs = new Counter('clients_synced_after_writes_started');

export const options = {
  scenarios: {
    clients: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${CONNECT_S + WRITE_S + DRAIN_S + 30}s`,
      exec: 'client',
    },
    sampler: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${CONNECT_S + WRITE_S + DRAIN_S + 30}s`,
      exec: 'sampler',
    },
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const httpBase = (ws) => ws.replace(/^ws/, 'http');

/**
 * Heap used after a forced full GC, summed over nodes. Requires the nodes to
 * run with --expose-gc and BENCH_GC_ENDPOINT=true; returns null otherwise.
 */
function heapAfterGc() {
  let total = 0;
  for (const url of [...new Set(target.urls)]) {
    const res = http.post(`${httpBase(url)}/debug/gc`, null, { tags: { name: 'gc' } });
    if (res.status !== 200) return null;
    const mem = JSON.parse(String(res.body));
    // external holds Buffers/ArrayBuffers (socket frames), which heapUsed excludes.
    total += mem.heapUsed + mem.external;
  }
  return total;
}

/** Sums a Prometheus metric across all collab nodes. */
function scrape(name) {
  let total = 0;
  for (const url of [...new Set(target.urls)]) {
    const res = http.get(`${httpBase(url)}/metrics`, { tags: { name: 'metrics' } });
    const line = String(res.body)
      .split('\n')
      .find((l) => l.startsWith(name + '{') || l.startsWith(name + ' '));
    if (line) total += Number(line.split(' ').pop());
  }
  return total;
}

export function setup() {
  const now = Date.now();
  const gcHeap = heapAfterGc();
  return {
    rss: scrape('process_resident_memory_bytes'),
    heap: gcHeap ?? scrape('nodejs_heap_size_used_bytes'),
    heapAfterGc: gcHeap !== null,
    writeFrom: now + CONNECT_S * 1000,
    writeUntil: now + (CONNECT_S + WRITE_S) * 1000,
    closeAt: now + (CONNECT_S + WRITE_S + DRAIN_S) * 1000,
  };
}

export function sampler(data) {
  heapMeasuredAfterGc.add(data.heapAfterGc ? 1 : 0);
  rssIdle.add(data.rss);
  heapIdle.add(data.heap);
  // Sample once everyone is connected, just before writes start.
  setTimeout(
    () => {
      const gcHeap = data.heapAfterGc ? heapAfterGc() : null;
      rssLoaded.add(scrape('process_resident_memory_bytes'));
      heapLoaded.add(gcHeap ?? scrape('nodejs_heap_size_used_bytes'));
      connectionsLoaded.add(scrape('collab_active_connections'));
    },
    Math.max(0, data.writeFrom - Date.now() - 1000),
  );
}

function message(docName, write) {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, docName);
  write(e);
  return encoding.toUint8Array(e).buffer;
}

// "PRB<writer>x<seq>x<sendMs>" embedded in the card title; ASCII, so it
// appears verbatim inside the binary Yjs update.
const P = 0x50,
  R = 0x52,
  B = 0x42;

export function client(data) {
  // Index within the clients scenario (exec.vu.idInTest is shared with the
  // sampler scenario, which would otherwise steal a writer slot).
  const vu = exec.scenario.iterationInTest + 1;
  const writer = vu <= WRITERS ? vu : 0;
  const url = target.urls[(vu - 1) % target.urls.length];
  const token = target.tokens[(vu - 1) % target.tokens.length];
  const docName = `board:${target.boardId}`;
  const doc = new Y.Doc();
  doc.clientID = 1_000_000 + vu; // unique and stable per VU
  const seen = new Set();
  const openedAt = Date.now();
  let synced = false;
  let writeTimer = null;

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  // Like the browser provider: publish presence and renew it every 15s. Besides
  // being realistic load, this is what keeps an idle-but-open connection alive
  // (Hocuspocus closes sockets that send nothing for longer than its timeout).
  const awareness = new Awareness(doc);
  const sendAwareness = () =>
    ws.send(
      message(docName, (e) => {
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [doc.clientID]));
      }),
    );
  let heartbeat = null;

  const scan = (bytes) => {
    const now = Date.now();
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] !== P || bytes[i + 1] !== R || bytes[i + 2] !== B) continue;
      let j = i + 3;
      let s = '';
      while (j < bytes.length && ((bytes[j] >= 48 && bytes[j] <= 57) || bytes[j] === 120)) {
        s += String.fromCharCode(bytes[j]);
        j++;
      }
      const [w, seq, sent] = s.split('x');
      if (!sent || Number(w) === writer || seen.has(`${w}:${seq}`)) continue;
      seen.add(`${w}:${seq}`);
      probesReceived.add(1);
      fanoutLatency.add(now - Number(sent));
      i = j;
    }
  };

  ws.onopen = () => {
    ws.send(
      message(docName, (e) => {
        encoding.writeVarUint(e, MSG_AUTH);
        encoding.writeVarUint(e, AUTH_TOKEN);
        encoding.writeVarString(e, token);
      }),
    );
  };

  ws.onmessage = (event) => {
    const bytes = new Uint8Array(event.data);
    const d = decoding.createDecoder(bytes);
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type === MSG_AUTH) {
      const sub = decoding.readVarUint(d);
      if (sub === AUTH_DENIED) {
        authFailures.add(1);
        ws.close();
      } else if (sub === AUTH_OK) {
        awareness.setLocalState({ user: { id: `load-${vu}`, name: `Load ${vu}`, color: '#888' } });
        if (HEARTBEAT) {
          sendAwareness();
          heartbeat = setInterval(sendAwareness, 15_000);
        }
        // Same handshake as the browser: send our state vector (step 1).
        ws.send(
          message(docName, (e) => {
            encoding.writeVarUint(e, MSG_SYNC);
            encoding.writeVarUint(e, SYNC_STEP1);
            encoding.writeVarUint8Array(e, Y.encodeStateVector(doc));
          }),
        );
      }
      return;
    }
    if (type !== MSG_SYNC && type !== MSG_SYNC_REPLY) return; // awareness, status...
    const sub = decoding.readVarUint(d);
    const payload = decoding.readVarUint8Array(d);
    if (sub === SYNC_STEP1) {
      // Server asks what we have that it lacks: reply with step 2.
      ws.send(
        message(docName, (e) => {
          encoding.writeVarUint(e, MSG_SYNC);
          encoding.writeVarUint(e, SYNC_STEP2);
          encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(doc, payload));
        }),
      );
    } else if (sub === SYNC_STEP2 && !synced) {
      synced = true;
      clientsSynced.add(1);
      syncTime.add(Date.now() - openedAt);
      if (Date.now() >= data.writeFrom) lateSyncs.add(1);
    } else if (sub === SYNC_UPDATE) {
      scan(payload);
    }
  };

  ws.onerror = () => wsErrors.add(1);
  let closing = false;
  ws.onclose = () => {
    if (!closing) unexpectedCloses.add(1);
  };

  if (writer) {
    let seq = 0;
    doc.on('update', (update) => {
      ws.send(
        message(docName, (e) => {
          encoding.writeVarUint(e, MSG_SYNC);
          encoding.writeVarUint(e, SYNC_UPDATE);
          encoding.writeVarUint8Array(e, update);
        }),
      );
    });
    setTimeout(
      () => {
        writeTimer = setInterval(() => {
          if (Date.now() >= data.writeUntil) {
            clearInterval(writeTimer);
            return;
          }
          seq += 1;
          addCard(doc, { columnId: target.columnId, title: `PRB${writer}x${seq}x${Date.now()}` });
          probesSent.add(1);
        }, 1000 / WRITE_HZ);
      },
      Math.max(0, data.writeFrom - Date.now()),
    );
  }

  setTimeout(
    () => {
      closing = true;
      receivedPerClient.add(seen.size);
      if (heartbeat) clearInterval(heartbeat);
      awareness.destroy();
      ws.close();
    },
    Math.max(0, data.closeAt - Date.now()),
  );
}

export function handleSummary(data) {
  const m = (name) => data.metrics[name]?.values ?? {};
  const synced = m('clients_synced').count ?? 0;
  const sent = m('probes_sent').count ?? 0;
  const received = m('probes_received').count ?? 0;
  const expected = sent * Math.max(0, synced - 1);
  const latency = m('fanout_latency');
  const conns = m('collab_connections_loaded').value ?? 0;
  const rssDelta =
    (m('collab_rss_loaded_bytes').value ?? 0) - (m('collab_rss_idle_bytes').value ?? 0);
  const heapDelta =
    (m('collab_heap_loaded_bytes').value ?? 0) - (m('collab_heap_idle_bytes').value ?? 0);
  const result = {
    label: LABEL,
    nodes: [...new Set(target.urls)].length,
    vus: VUS,
    writers: WRITERS,
    writeHzPerWriter: WRITE_HZ,
    clientsSynced: synced,
    authFailures: m('auth_failures').count ?? 0,
    wsErrors: m('ws_errors').count ?? 0,
    unexpectedCloses: m('unexpected_closes').count ?? 0,
    probesSent: sent,
    deliveriesExpected: expected,
    deliveriesReceived: received,
    dropped: expected - received,
    fanoutLatencyMs: {
      p50: latency.med,
      p95: latency['p(95)'],
      p99: latency['p(99)'],
      max: latency.max,
      avg: latency.avg,
    },
    timeToSyncMs: {
      p50: m('time_to_sync').med,
      p95: m('time_to_sync')['p(95)'],
      max: m('time_to_sync').max,
    },
    clientsSyncedAfterWritesStarted: m('clients_synced_after_writes_started').count ?? 0,
    receivedPerClient: {
      min: m('received_per_client').min,
      med: m('received_per_client').med,
      max: m('received_per_client').max,
    },
    memory: {
      connectionsAtSample: conns,
      rssDeltaBytes: rssDelta,
      heapDeltaBytes: heapDelta,
      heapMeasuredAfterFullGc: m('heap_measured_after_gc').value === 1,
      // heapUsed + external after a full GC: the meaningful per-connection figure.
      heapPerConnectionKiB: conns ? Math.round(heapDelta / conns / 102.4) / 10 : null,
      // RSS is reported raw only: a forced GC returns memory to the OS between
      // samples, so the RSS delta is not a per-connection cost.
    },
    finishedAt: new Date().toISOString(),
  };
  const text = `\n${JSON.stringify(result, null, 2)}\n`;
  return {
    stdout: text,
    [`load/results/${LABEL}.json`]: JSON.stringify(result, null, 2),
  };
}
