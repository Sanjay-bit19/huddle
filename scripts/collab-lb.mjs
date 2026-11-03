#!/usr/bin/env node
// Minimal round-robin TCP load balancer for local multi-node testing without
// Docker (docker-compose uses nginx for the same job). Connection-level, no
// stickiness: consecutive WebSocket connections alternate between nodes.
//
//   node scripts/collab-lb.mjs 1234 127.0.0.1:1235 127.0.0.1:1236
import net from 'node:net';

const [listenPort = '1234', ...targets] = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: collab-lb.mjs <listenPort> <host:port> [host:port...]');
  process.exit(1);
}
const upstreams = targets.map((t) => {
  const [host, port] = t.split(':');
  return { host, port: Number(port) };
});
let next = 0;

net
  .createServer((client) => {
    const target = upstreams[next++ % upstreams.length];
    const upstream = net.connect(target.port, target.host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
    client.on('close', close);
    upstream.on('close', close);
  })
  .listen(Number(listenPort), () => {
    console.log(`collab-lb :${listenPort} -> ${targets.join(', ')}`);
  });
