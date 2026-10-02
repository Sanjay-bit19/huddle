#!/usr/bin/env node
// Prepares a k6 run: creates a workspace + board through the real API and
// mints editor tokens for the virtual users. Writes load/results/target.json.
//
//   API_URL=http://localhost:4000 COLLAB_URLS=ws://127.0.0.1:1235,ws://127.0.0.1:1236 \
//   node load/setup.mjs
// The API must run with RATE_LIMIT_DISABLED=true (it creates many accounts).
import { mkdirSync, writeFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:4000';
const COLLAB_URLS = (process.env.COLLAB_URLS ?? 'ws://127.0.0.1:1234').split(',');
const USERS = Number(process.env.LOAD_USERS ?? 20);
const run = Date.now();

async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const signup = (i) =>
  call('/api/auth/signup', {
    body: {
      email: `load-${run}-${i}@load.test`,
      name: `Load ${i}`,
      password: 'load-test-password',
    },
  });

const owner = await signup('owner');
const ws = await call('/api/workspaces', {
  token: owner.accessToken,
  body: { name: `Load ${run}` },
});
const board = await call(`/api/workspaces/${ws.workspace.id}/boards`, {
  token: owner.accessToken,
  body: { title: 'k6 fan-out' },
});
const invite = await call(`/api/workspaces/${ws.workspace.id}/invites`, {
  token: owner.accessToken,
  body: { role: 'EDITOR', maxUses: USERS },
});

const tokens = [owner.accessToken];
for (let i = 1; i < USERS; i++) {
  const user = await signup(i);
  await call(`/api/invites/${invite.token}/accept`, { token: user.accessToken, body: {} });
  tokens.push(user.accessToken);
}

const target = {
  boardId: board.board.id,
  // Deterministic seed column id (see packages/shared/src/board/seed.ts).
  columnId: `${board.board.id}:col0`,
  urls: COLLAB_URLS,
  tokens,
  createdAt: new Date().toISOString(),
};
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/target.json', import.meta.url), JSON.stringify(target, null, 2));
console.log(`board ${target.boardId}, ${tokens.length} users, collab: ${COLLAB_URLS.join(' ')}`);
