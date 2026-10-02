#!/usr/bin/env bash
# Reproduces the README load-test numbers. Each scenario gets FRESH collab
# processes (production build, --expose-gc for post-GC heap measurement).
#
# Prereqs: Postgres + Redis running, the API running with
# RATE_LIMIT_DISABLED=true on :4000, k6 on PATH (or K6=/path/to/k6),
# and `pnpm --filter @huddle/collab build && pnpm load:build`.
set -euo pipefail
cd "$(dirname "$0")/.."
K6="${K6:-k6}"
LOGS="${LOGS:-/tmp/huddle-load}"
mkdir -p "$LOGS"
set -a; [ -f .env ] && . ./.env; set +a

start_nodes() {
  for port in "$@"; do
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  done
  sleep 1
  for port in "$@"; do
    (cd apps/collab && NODE_ENV=production LOG_LEVEL=warn PORT="$port" INSTANCE_ID="bench-$port" \
      BENCH_GC_ENDPOINT=true node --expose-gc dist/index.js >"$LOGS/collab-$port.log" 2>&1 &)
  done
  for port in "$@"; do
    until curl -sf "localhost:$port/healthz" >/dev/null; do sleep 0.2; done
  done
}

stop_nodes() {
  for port in "$@"; do fuser -k "${port}/tcp" >/dev/null 2>&1 || true; done
}

# run <label> <urls> <writers> <hz> [extra env assignments...]
run() {
  local label=$1 urls=$2 writers=$3 hz=$4
  shift 4
  echo "== $label"
  COLLAB_URLS="$urls" LOAD_USERS=20 node load/setup.mjs
  env VUS="${VUS:-200}" WRITERS="$writers" WRITE_HZ="$hz" LABEL="$label" "$@" \
    "$K6" run --quiet load/dist/ws-fanout.js
}

TWO=ws://127.0.0.1:1235,ws://127.0.0.1:1236
# Optional: pass scenario groups to run a subset, e.g. `load/run-all.sh idle`.
GROUPS_TO_RUN="${*:-fanout idle}"

if [[ " $GROUPS_TO_RUN " == *" fanout "* ]]; then
  start_nodes 1235
  run single-node-200 ws://127.0.0.1:1235 5 2
  stop_nodes 1235

  start_nodes 1235 1236
  run two-nodes-200 "$TWO" 5 2
  stop_nodes 1235 1236

  start_nodes 1235 1236
  run two-nodes-200-stress "$TWO" 20 5
  stop_nodes 1235 1236
fi

# Clients that stay silent for 40s (longer than the server's 30s idle
# timeout) before the writers start: without the awareness heartbeat that the
# real browser provider sends, the server closes them and they miss updates.
if [[ " $GROUPS_TO_RUN " == *" idle "* ]]; then
  start_nodes 1235 1236
  VUS=50 run idle-40s-no-heartbeat "$TWO" 5 2 CONNECT_S=40 HEARTBEAT=0
  stop_nodes 1235 1236

  start_nodes 1235 1236
  VUS=50 run idle-40s-heartbeat "$TWO" 5 2 CONNECT_S=40 HEARTBEAT=1
  stop_nodes 1235 1236
fi
