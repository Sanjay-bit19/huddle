import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import * as Y from 'yjs';
import {
  boards,
  createDb,
  initBoardDocument,
  sessions,
  users,
  workspaceMembers,
  workspaces,
  type DbHandle,
} from '@huddle/db';
import { boardDocumentName, type Role } from '@huddle/shared';
import { createSeedUpdate } from '@huddle/shared/board';
import { signAccessToken } from '@huddle/shared/server';
import { loadCollabConfig } from '../src/config';
import { createCollabServer, type CollabServer } from '../src/server';

export const JWT_SECRET = 'collab-test-secret-collab-test-secret-1';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function testDb(): DbHandle {
  return createDb(process.env.DATABASE_URL!, { max: 5 });
}

export async function resetDb(handle: DbHandle) {
  const { rows } = await handle.pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (tables) await handle.db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
}

export interface RunningCollab extends CollabServer {
  port: number;
  url: string;
}

export async function startCollab(
  handle: DbHandle,
  opts: { instanceId?: string; prefix: string; env?: Record<string, string> },
): Promise<RunningCollab> {
  const config = loadCollabConfig({
    NODE_ENV: 'test',
    JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    INSTANCE_ID: opts.instanceId ?? `test-${randomUUID().slice(0, 6)}`,
    REDIS_PREFIX: opts.prefix,
    STORE_DEBOUNCE_MS: '200',
    STORE_MAX_DEBOUNCE_MS: '1000',
    UPDATE_LOG_FLUSH_MS: '20',
    ...opts.env,
  });
  const collab = createCollabServer({
    config,
    db: handle.db,
    logger: pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' }),
  });
  const port = await collab.listen(await freePort());
  return Object.assign(collab, { port, url: `ws://127.0.0.1:${port}` });
}

export interface Fixture {
  workspaceId: string;
  boardId: string;
  member(role: Role, name?: string): Promise<{ userId: string; sessionId: string; token: string }>;
}

export async function createFixture(handle: DbHandle): Promise<Fixture> {
  const { db } = handle;
  const [ws] = await db.insert(workspaces).values({ name: 'Test WS' }).returning();
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: ws!.id, title: 'Test board' })
    .returning();
  await initBoardDocument(db, board!.id, createSeedUpdate(board!.id));
  return {
    workspaceId: ws!.id,
    boardId: board!.id,
    async member(role, name = role.toLowerCase()) {
      const [user] = await db
        .insert(users)
        .values({ email: `${name}-${randomUUID()}@example.com`, name, passwordHash: 'x' })
        .returning();
      await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: user!.id, role });
      const [session] = await db.insert(sessions).values({ userId: user!.id }).returning();
      const token = await signAccessToken(
        { sub: user!.id, name, sid: session!.id },
        JWT_SECRET,
        600,
      );
      return { userId: user!.id, sessionId: session!.id, token };
    },
  };
}

export interface TestClient {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  synced: Promise<void>;
  authFailure: Promise<string>;
  closed: Promise<string>;
  statelessMessages: string[];
  destroy(): void;
}

export function connect(
  url: string,
  boardId: string,
  token: string,
  doc = new Y.Doc(),
): TestClient {
  let resolveSynced!: () => void;
  let resolveAuthFailure!: (reason: string) => void;
  let resolveClosed!: (reason: string) => void;
  const synced = new Promise<void>((r) => (resolveSynced = r));
  const authFailure = new Promise<string>((r) => (resolveAuthFailure = r));
  const closed = new Promise<string>((r) => (resolveClosed = r));
  const statelessMessages: string[] = [];
  const provider = new HocuspocusProvider({
    url,
    name: boardDocumentName(boardId),
    document: doc,
    token,
    onSynced: () => resolveSynced(),
    onAuthenticationFailed: ({ reason }) => resolveAuthFailure(reason),
    onClose: ({ event }) => resolveClosed(String(event.reason)),
    onStateless: ({ payload }) => statelessMessages.push(payload),
  });
  return {
    provider,
    doc,
    synced,
    authFailure,
    closed,
    statelessMessages,
    destroy: () => provider.destroy(),
  };
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 20, message = 'condition' } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${message}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
