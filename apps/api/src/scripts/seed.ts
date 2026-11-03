import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import {
  appendBoardUpdates,
  boards,
  createDb,
  initBoardDocument,
  loadBoardDoc,
  runMigrations,
  syncCardSearch,
  users,
  workspaceMembers,
  workspaces,
} from '@huddle/db';
import { addCard, createSeedUpdate, readBoard, toggleAssignee } from '@huddle/shared/board';

/**
 * Demo data advertised in the README:
 *   demo@huddle.dev  (ADMIN)   password: DEMO_PASSWORD or "huddle-demo-2026"
 *   viewer@huddle.dev (VIEWER) same password - shows read-only mode
 * Idempotent: re-running does not duplicate anything.
 */
const url = process.env.DATABASE_URL ?? 'postgres://huddle:huddle@localhost:5432/huddle';
const password = process.env.DEMO_PASSWORD ?? 'huddle-demo-2026';
const handle = createDb(url, { max: 2 });
const { db } = handle;

async function ensureUser(email: string, name: string) {
  const passwordHash = await hash(password);
  await db
    .insert(users)
    .values({ email, name, passwordHash })
    .onConflictDoNothing({ target: users.email });
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user!;
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

try {
  await runMigrations(db);
  const demo = await ensureUser('demo@huddle.dev', 'Demo Admin');
  const viewer = await ensureUser('viewer@huddle.dev', 'Vera Viewer');

  let [ws] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.name, 'Huddle Demo'), eq(workspaces.createdBy, demo.id)));
  if (!ws) {
    [ws] = await db
      .insert(workspaces)
      .values({ name: 'Huddle Demo', createdBy: demo.id })
      .returning();
  }
  await db
    .insert(workspaceMembers)
    .values([
      { workspaceId: ws!.id, userId: demo.id, role: 'ADMIN' },
      { workspaceId: ws!.id, userId: viewer.id, role: 'VIEWER' },
    ])
    .onConflictDoNothing();

  const existing = await db.select().from(boards).where(eq(boards.workspaceId, ws!.id));
  if (existing.length === 0) {
    const [board] = await db
      .insert(boards)
      .values({
        workspaceId: ws!.id,
        title: 'Launch plan',
        description: 'Everything needed to ship v1',
        createdBy: demo.id,
      })
      .returning();
    await initBoardDocument(db, board!.id, createSeedUpdate(board!.id));

    const doc = await loadBoardDoc(db, board!.id);
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const [todo, doing, done] = readBoard(doc).columns;
    const actor = { userId: demo.id };
    const cards: Array<Parameters<typeof addCard>[1]> = [
      {
        columnId: todo!.id,
        title: 'Write the launch blog post',
        labels: ['marketing'],
        dueDate: day(6),
        description: 'Story: why real-time boards, what is new in v1.',
        checklist: ['Outline', 'First draft', 'Review'],
      },
      {
        columnId: todo!.id,
        title: 'Record a 2 minute demo video',
        labels: ['marketing'],
        dueDate: day(9),
      },
      {
        columnId: todo!.id,
        title: 'Load test 500 concurrent editors',
        labels: ['infra'],
        description: 'Extend the k6 fan-out scenario and compare 1 vs 3 collab nodes.',
      },
      {
        columnId: doing!.id,
        title: 'Fix flaky login test',
        labels: ['bug', 'blocked'],
        dueDate: day(-2),
        description: 'Fails about 1 in 20 CI runs. Blocked on a CI runner image update.',
      },
      {
        columnId: doing!.id,
        title: 'Onboarding checklist for new workspaces',
        labels: ['product'],
        checklist: ['Empty states', 'Sample board', 'Invite prompt'],
      },
      {
        columnId: doing!.id,
        title: 'Rate-limit AI endpoints per workspace',
        labels: ['infra'],
        dueDate: day(3),
      },
      { columnId: done!.id, title: 'Offline editing with IndexedDB', labels: ['product'] },
      { columnId: done!.id, title: 'Redis fan-out across collab nodes', labels: ['infra'] },
    ];
    const ids = cards.map((c) => addCard(doc, c, actor));
    toggleAssignee(doc, ids[0]!, demo.id, actor);
    toggleAssignee(doc, ids[3]!, demo.id, actor);
    await appendBoardUpdates(
      db,
      updates.map((update) => ({ boardId: board!.id, update, userId: demo.id })),
    );
    await syncCardSearch(db, board!.id, readBoard(doc));
    doc.destroy();
    console.log(`seeded board ${board!.id}`);
  }
  console.log('demo accounts: demo@huddle.dev (admin), viewer@huddle.dev (viewer)');
} finally {
  await handle.close();
}
