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

run() {
  local label=$1 urls=$2 writers=$3 hz=$4
  echo "== $label"
  COLLAB_URLS="$urls" LOAD_USERS=20 node load/setup.mjs
  VUS=200 WRITERS="$writers" WRITE_HZ="$hz" LABEL="$label" "$K6" run --quiet load/dist/ws-fanout.js
}

start_nodes 1235
run single-node-200 ws://127.0.0.1:1235 5 2
stop_nodes 1235

start_nodes 1235 1236
run two-nodes-200 ws://127.0.0.1:1235,ws://127.0.0.1:1236 5 2
stop_nodes 1235 1236

start_nodes 1235 1236
run two-nodes-200-stress ws://127.0.0.1:1235,ws://127.0.0.1:1236 20 5
stop_nodes 1235 1236
