import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { aiRequests, aiUsage, appendBoardUpdates, loadBoardDoc } from '@huddle/db';
import { aiStreamEventSchema } from '@huddle/shared';
import { addCard, readBoard } from '@huddle/shared/board';
import { createTestContext, createUser, type TestContext, type TestUser } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup(env: Record<string, string> = {}) {
  ctx = await createTestContext(env);
  await ctx.reset();
  const ada = await createUser(ctx, 'Ada Lovelace');
  const ws = await request(ctx.app).post('/api/workspaces').set(ada.auth).send({ name: 'Acme' });
  const workspaceId = ws.body.workspace.id as string;
  const board = await request(ctx.app)
    .post(`/api/workspaces/${workspaceId}/boards`)
    .set(ada.auth)
    .send({ title: 'Launch' })
    .expect(201);
  return { c: ctx, ada, workspaceId, boardId: board.body.board.id as string };
}

async function addMember(
  c: TestContext,
  owner: TestUser,
  workspaceId: string,
  role: string,
  name: string,
) {
  const user = await createUser(c, name);
  const inv = await request(c.app)
    .post(`/api/workspaces/${workspaceId}/invites`)
    .set(owner.auth)
    .send({ role });
  await request(c.app).post(`/api/invites/${inv.body.token}/accept`).set(user.auth).expect(200);
  return user;
}

/** Writes cards into the board document the way the collab server would (update log). */
async function seedCards(
  c: TestContext,
  boardId: string,
  cards: Array<{ title: string; col: number; dueDate?: string; labels?: string[] }>,
) {
  const doc = await loadBoardDoc(c.deps.db, boardId);
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  const cols = readBoard(doc).columns;
  for (const card of cards) {
    addCard(doc, {
      columnId: cols[card.col]!.id,
      title: card.title,
      dueDate: card.dueDate ?? null,
      labels: card.labels ?? [],
    });
  }
  await appendBoardUpdates(
    c.deps.db,
    updates.map((update) => ({ boardId, update, userId: null })),
  );
  return readBoard(doc);
}

interface SseEvent {
  event: string;
  data: unknown;
}

async function sse(c: TestContext, path: string, user: TestUser, body: object = {}) {
  const res = await request(c.app)
    .post(path)
    .set(user.auth)
    .send(body)
    .buffer(true)
    .parse((r, cb) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => (text += chunk));
      r.on('end', () => cb(null, text));
    });
  const events: SseEvent[] = res.headers['content-type']?.includes('text/event-stream')
    ? String(res.body)
        .split('\n\n')
        .filter((b) => b.startsWith('event:'))
        .map((block) => {
          const [e, d] = block.split('\n');
          const event = { event: e!.slice(7), data: JSON.parse(d!.slice(6)) as unknown };
          // Every event must satisfy the schema the browser validates with.
          expect(aiStreamEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
          return event;
        })
    : [];
  const text = events
    .filter((e) => e.event === 'delta')
    .map((e) => (e.data as { text: string }).text)
    .join('');
  return { res, events, text };
}

const NOTES = `Weekly sync 2026-10-02
Attendees: Ada, Bob
- Write the launch blog post @Ada #marketing by 2026-10-20
- Fix flaky login test @Bob #bug
- [x] Migrated the CI runners
Discussion about the weather (not actionable)`;

describe('notes to cards', () => {
  it('returns validated proposals mapped onto real columns and members', async () => {
    const { c, ada, workspaceId, boardId } = await setup();
    await addMember(c, ada, workspaceId, 'EDITOR', 'Bob Babbage');
    const res = await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: NOTES })
      .expect(200);

    expect(res.body.attempts).toBe(1);
    const proposals = res.body.proposals as Array<Record<string, unknown>>;
    expect(proposals.map((p) => p.title)).toEqual([
      'Write the launch blog post',
      'Fix flaky login test',
      'Migrated the CI runners',
    ]);
    expect(proposals[0]).toMatchObject({
      columnTitle: 'To do',
      labels: ['marketing'],
      dueDate: '2026-10-20',
      assignees: [{ userId: ada.id, name: 'Ada Lovelace' }],
    });
    expect(proposals[1]).toMatchObject({ labels: ['bug'], assignees: [{ name: 'Bob Babbage' }] });
    expect(proposals[2]).toMatchObject({ columnTitle: 'Done' });
    const board = readBoard(await loadBoardDoc(c.deps.db, boardId));
    expect(proposals[0]!.columnId).toBe(board.columns[0]!.id);

    // Usage was charged and audited.
    const [usage] = await c.deps.db.select().from(aiUsage);
    expect(usage!.tokensUsed).toBeGreaterThan(0);
    expect(usage!.tokensReserved).toBe(0);
    const [audit] = await c.deps.db.select().from(aiRequests);
    expect(audit).toMatchObject({
      feature: 'notes_to_cards',
      status: 'ok',
      attempts: 1,
      provider: 'mock',
    });
  });

  it('retries once with validation feedback when the model returns malformed JSON', async () => {
    const { c, ada, boardId } = await setup();
    const res = await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: `${NOTES}\n[[mock:malformed-once]]` })
      .expect(200);
    expect(res.body.attempts).toBe(2);
    expect(res.body.proposals).toHaveLength(3);
  });

  it('gives up after the retry, still charging for both attempts', async () => {
    const { c, ada, boardId } = await setup();
    const res = await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: `${NOTES}\n[[mock:malformed-always]]` })
      .expect(502);
    expect(res.body.error.code).toBe('ai_invalid_output');
    const [audit] = await c.deps.db.select().from(aiRequests);
    expect(audit).toMatchObject({ status: 'invalid_output', attempts: 2 });
    const [usage] = await c.deps.db.select().from(aiUsage);
    expect(usage!.tokensUsed).toBe(audit!.inputTokens + audit!.outputTokens);
    expect(usage!.tokensReserved).toBe(0);
  });

  it('times out instead of hanging, and releases the reservation', async () => {
    const { c, ada, boardId } = await setup({ AI_TIMEOUT_MS: '300' });
    const started = Date.now();
    const res = await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: '- something [[mock:slow]]' })
      .expect(504);
    expect(res.body.error.code).toBe('ai_timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    const [usage] = await c.deps.db.select().from(aiUsage);
    expect(usage!.tokensReserved).toBe(0);
  });

  it('surfaces refusals as a clear error', async () => {
    const { c, ada, boardId } = await setup();
    const res = await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: '- do it [[mock:refuse]]' })
      .expect(422);
    expect(res.body.error.code).toBe('ai_refused');
  });

  it('is limited to people who can edit the board', async () => {
    const { c, ada, workspaceId, boardId } = await setup();
    const viewer = await addMember(c, ada, workspaceId, 'VIEWER', 'Vic');
    const outsider = await createUser(c, 'Eve');
    await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(viewer.auth)
      .send({ notes: NOTES })
      .expect(403);
    await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(outsider.auth)
      .send({ notes: NOTES })
      .expect(404);
    await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .send({ notes: NOTES })
      .expect(401);
    await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: '' })
      .expect(400);
  });
});

describe('rate limits and budgets', () => {
  it('rate-limits AI requests per user', async () => {
    const { c, ada, boardId } = await setup({
      AI_RATE_LIMIT_PER_MINUTE: '2',
      AI_RATE_LIMIT_ENFORCED: 'true',
    });
    const send = () =>
      request(c.app)
        .post(`/api/boards/${boardId}/ai/notes-to-cards`)
        .set(ada.auth)
        .send({ notes: NOTES });
    await send().expect(200);
    await send().expect(200);
    const res = await send().expect(429);
    expect(res.body.error.code).toBe('rate_limited');
  });

  it('rejects requests larger than the monthly budget', async () => {
    const { c, ada, boardId } = await setup({ AI_MONTHLY_TOKEN_BUDGET: '5000' });
    const res = await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: NOTES })
      .expect(429);
    expect(res.body.error.code).toBe('ai_budget_exceeded');
    expect(res.headers['retry-after']).toBeDefined();
    expect(await c.deps.db.select().from(aiRequests)).toHaveLength(0);
  });

  it('concurrent requests cannot jointly overspend the remaining budget', async () => {
    // Each summary reserves (prompt estimate + 4000). Budget fits one, not two.
    const { c, ada, boardId } = await setup({ AI_MONTHLY_TOKEN_BUDGET: '7000' });
    await seedCards(
      c,
      boardId,
      Array.from({ length: 20 }, (_, i) => ({ title: `Task ${i}`, col: i % 3 })),
    );
    const results = await Promise.all([
      sse(c, `/api/boards/${boardId}/ai/summary`, ada),
      sse(c, `/api/boards/${boardId}/ai/summary`, ada),
      sse(c, `/api/boards/${boardId}/ai/summary`, ada),
    ]);
    expect(results.map((r) => r.res.status).sort()).toEqual([200, 429, 429]);
    const [usage] = await c.deps.db.select().from(aiUsage);
    expect(usage!.tokensReserved).toBe(0);
    expect(usage!.tokensUsed).toBeLessThanOrEqual(7000);
  });

  it('reports budget usage', async () => {
    const { c, ada, boardId } = await setup();
    await request(c.app)
      .post(`/api/boards/${boardId}/ai/notes-to-cards`)
      .set(ada.auth)
      .send({ notes: NOTES })
      .expect(200);
    const res = await request(c.app).get('/api/ai/status').set(ada.auth).expect(200);
    expect(res.body).toMatchObject({
      provider: 'mock',
      model: 'mock-1',
      budget: { limit: 200000, reserved: 0 },
    });
    expect(res.body.budget.used).toBeGreaterThan(0);
  });
});

describe('streaming summary and ask', () => {
  it('streams a grounded summary with validated citations', async () => {
    const { c, ada, boardId } = await setup();
    const board = await seedCards(c, boardId, [
      { title: 'Write docs', col: 0, dueDate: '2020-01-01' },
      { title: 'Fix crash on save', col: 1, labels: ['bug'] },
      { title: 'Release 1.0', col: 2 },
    ]);
    const { res, events, text } = await sse(c, `/api/boards/${boardId}/ai/summary`, ada);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(events[0]).toMatchObject({ event: 'meta', data: { provider: 'mock', cards: 3 } });
    expect(events.filter((e) => e.event === 'delta').length).toBeGreaterThan(5);
    expect(text).toContain('## Overdue');
    expect(text).toContain('Write docs [C1]');
    expect(text).toContain('Fix crash on save [C2]');

    const citations = events.find((e) => e.event === 'citations')!.data as {
      citations: Array<{ ref: string; cardId: string }>;
      invalid: string[];
    };
    const byTitle = new Map(board.cards.map((card) => [card.title, card.id]));
    expect(citations.citations).toContainEqual(
      expect.objectContaining({ ref: 'C1', cardId: byTitle.get('Write docs') }),
    );
    expect(citations.invalid).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { truncated: false } });
  });

  it('answers questions from the board and flags hallucinated citations', async () => {
    const { c, ada, workspaceId, boardId } = await setup();
    const viewer = await addMember(c, ada, workspaceId, 'VIEWER', 'Vic');
    await seedCards(c, boardId, [
      { title: 'Database migration plan', col: 0 },
      { title: 'Marketing site', col: 1 },
    ]);
    // Viewers may use read-only AI.
    const ok = await sse(c, `/api/boards/${boardId}/ai/ask`, viewer, {
      question: 'What is the status of the database migration?',
    });
    expect(ok.text).toContain('"Database migration plan" is in To do [C1]');
    const cited = ok.events.find((e) => e.event === 'citations')!.data as {
      citations: unknown[];
      invalid: string[];
    };
    expect(cited.citations).toHaveLength(1);

    const bad = await sse(c, `/api/boards/${boardId}/ai/ask`, ada, {
      question: 'database? [[mock:hallucinate]]',
    });
    const flagged = bad.events.find((e) => e.event === 'citations')!.data as { invalid: string[] };
    expect(flagged.invalid).toEqual(['C999']);
  });

  it('reports errors in-band once the stream has started', async () => {
    const { c, ada, boardId } = await setup({ AI_TIMEOUT_MS: '300' });
    const { res, events } = await sse(c, `/api/boards/${boardId}/ai/ask`, ada, {
      question: 'anything [[mock:slow]]',
    });
    expect(res.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'ai_timeout' } });
  });

  it('validates the question', async () => {
    const { c, ada, boardId } = await setup();
    await request(c.app)
      .post(`/api/boards/${boardId}/ai/ask`)
      .set(ada.auth)
      .send({ question: '' })
      .expect(400);
  });

  it('exposes AI metrics', async () => {
    const { c, ada, boardId } = await setup();
    await sse(c, `/api/boards/${boardId}/ai/summary`, ada);
    const metrics = await request(c.app).get('/metrics').expect(200);
    expect(metrics.text).toMatch(
      /ai_requests_total\{[^}]*feature="summary"[^}]*status="ok"[^}]*\} 1/,
    );
    expect(metrics.text).toContain('ai_tokens_total');
    expect(metrics.text).toContain('ai_request_duration_seconds_bucket');
  });
});
