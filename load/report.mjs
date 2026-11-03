#!/usr/bin/env node
// Renders load/results/*.json as the Markdown tables used in the README, so
// published numbers are copied from run output, never typed by hand.
//   node load/report.mjs            # print tables
//   node load/report.mjs --readme   # replace the marked sections in README.md
import { readFileSync, writeFileSync } from 'node:fs';

const read = (label) =>
  JSON.parse(readFileSync(new URL(`./results/${label}.json`, import.meta.url), 'utf8'));
const n = (v) => Math.round(v).toLocaleString('en-US');
const ms = (v) => `${n(v)} ms`;

const fanout = [
  ['single-node-200', '1 node, 5 writers × 2 Hz'],
  ['two-nodes-200', '2 nodes, 5 writers × 2 Hz'],
  ['two-nodes-200-stress', '2 nodes, 20 writers × 5 Hz target (overload)'],
].map(([label, scenario]) => ({ scenario, r: read(label) }));

const fanoutTable = [
  '| Scenario (200 clients) | Synced | Probes sent | Delivered / expected | Dropped | Unexpected closes | Fan-out p50 / p95 / p99 / max | Time to sync p50 / p95 | Heap + external per connection (after GC) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...fanout.map(
    ({ scenario, r }) =>
      `| ${scenario} | ${r.clientsSynced} / ${r.vus} | ${n(r.probesSent)} | ${n(r.deliveriesReceived)} / ${n(r.deliveriesExpected)} | **${n(r.dropped)}** | ${r.unexpectedCloses} | ${n(r.fanoutLatencyMs.p50)} / ${n(r.fanoutLatencyMs.p95)} / ${n(r.fanoutLatencyMs.p99)} / ${ms(r.fanoutLatencyMs.max)} | ${n(r.timeToSyncMs.p50)} / ${ms(r.timeToSyncMs.p95)} | ${r.memory.heapPerConnectionKiB} KiB${r.nodes > 1 ? ' (both nodes)' : ''} |`,
  ),
].join('\n');

const idle = [
  ['idle-40s-no-heartbeat', 'No heartbeat'],
  ['idle-40s-heartbeat', 'Awareness heartbeat every 15 s'],
].map(([label, scenario]) => ({ scenario, r: read(label) }));

const idleTable = [
  '| 50 clients, silent for 40 s | Unexpected closes | Delivered / expected | Dropped |',
  '| --- | --- | --- | --- |',
  ...idle.map(
    ({ scenario, r }) =>
      `| ${scenario} | ${r.unexpectedCloses} | ${n(r.deliveriesReceived)} / ${n(r.deliveriesExpected)} | **${n(r.dropped)}** |`,
  ),
].join('\n');

if (process.argv.includes('--readme')) {
  const path = new URL('../README.md', import.meta.url);
  let readme = readFileSync(path, 'utf8');
  const splice = (name, body) => {
    const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
    if (!re.test(readme)) throw new Error(`README marker ${name} not found`);
    readme = readme.replace(re, `$1\n\n${body}\n\n$2`);
  };
  splice('K6_TABLE', fanoutTable);
  splice('IDLE_TABLE', idleTable);
  writeFileSync(path, readme);
  console.log('README tables updated');
} else {
  console.log(`${fanoutTable}\n\n${idleTable}`);
}
