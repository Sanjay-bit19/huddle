import type {
  LlmJsonRequest,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamEvent,
  LlmUsage,
} from './types';
import { LlmRefusalError } from './types';

/**
 * Deterministic offline stand-in for an LLM, used by tests, CI, e2e and
 * keyless demos (the UI labels it "Mock AI"). It reads the same prompts the
 * real model receives and answers with simple heuristics, so the whole
 * pipeline (budgets, validation, retries, streaming, citations) is exercised
 * without network access.
 *
 * Test hooks embedded in the user's text:
 *   [[mock:malformed-once]]   first answer fails validation, retry succeeds
 *   [[mock:malformed-always]] every answer fails validation
 *   [[mock:slow]]             never answers (exercises timeouts / aborts)
 *   [[mock:refuse]]           declines (exercises refusal handling)
 *   [[mock:hallucinate]]      cites a card that does not exist
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-1';

  constructor(private readonly delayMs = 12) {}

  async completeJson(req: LlmJsonRequest): Promise<LlmResult> {
    const user = lastUser(req);
    await this.hooks(user, req.signal);
    const isRetry = req.messages.some((m) => m.role === 'assistant');
    let text: string;
    if (hasHook(req, 'malformed-always') || (hasHook(req, 'malformed-once') && !isRetry)) {
      text = '{"cards": [{"title": "", "column": 42}';
    } else {
      text = JSON.stringify({ cards: notesToCards(promptOf(req)) });
    }
    return { text, usage: usage(req, text), model: this.model, stopReason: 'end_turn' };
  }

  async *streamText(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const user = lastUser(req);
    await this.hooks(user, req.signal);
    const cards = parseCards(user);
    const question = /\nQuestion: ([\s\S]*)$/.exec(user)?.[1];
    let text = question ? answer(question, cards) : summary(cards, user);
    if (user.includes('[[mock:hallucinate]]')) text += ' See also [C999].';
    for (const chunk of text.match(/\S+\s*/g) ?? []) {
      if (req.signal.aborted) throw req.signal.reason;
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: chunk };
    }
    yield { type: 'end', usage: usage(req, text), model: this.model, stopReason: 'end_turn' };
  }

  private async hooks(text: string, signal: AbortSignal) {
    if (text.includes('[[mock:slow]]')) await sleep(10 * 60_000, signal);
    if (text.includes('[[mock:refuse]]'))
      throw new LlmRefusalError({ inputTokens: 10, outputTokens: 0 });
  }
}

// ---------------------------------------------------------------------------

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const lastUser = (req: LlmRequest) =>
  [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
const promptOf = (req: LlmRequest) => req.messages.find((m) => m.role === 'user')?.content ?? '';
const hasHook = (req: LlmRequest, hook: string) => promptOf(req).includes(`[[mock:${hook}]]`);
const tokens = (s: string) => Math.ceil(s.length / 4);
function usage(req: LlmRequest, out: string): LlmUsage {
  return {
    inputTokens: tokens(req.system) + req.messages.reduce((n, m) => n + tokens(m.content), 0),
    outputTokens: tokens(out),
  };
}

interface MockCard {
  ref: string;
  title: string;
  column: string;
  overdue: boolean;
  labels: string[];
  text: string;
}

function parseCards(prompt: string): MockCard[] {
  const cards: MockCard[] = [];
  let column = '';
  for (const line of prompt.split('\n')) {
    const col = /<column name="([^"]*)"/.exec(line);
    if (col) column = col[1]!;
    const card = /<card ref="(C\d+)" title="([^"]*)"([^>]*)>(.*)<\/card>/.exec(line);
    if (card) {
      cards.push({
        ref: card[1]!,
        title: card[2]!,
        column,
        overdue: card[3]!.includes('overdue="true"'),
        labels: /labels="([^"]*)"/.exec(card[3]!)?.[1]?.split(', ') ?? [],
        text: `${card[2]} ${card[4]}`.toLowerCase(),
      });
    }
  }
  return cards;
}

function summary(cards: MockCard[], prompt: string): string {
  const columns = [...prompt.matchAll(/<column name="([^"]*)" cards="(\d+)"/g)].map((m) => ({
    name: m[1]!,
    count: Number(m[2]),
  }));
  const blocked = cards.filter((c) => c.labels.some((l) => /block|bug|risk/.test(l)));
  const overdue = cards.filter((c) => c.overdue);
  const cite = (list: MockCard[]) => list.map((c) => `- ${c.title} [${c.ref}]`).join('\n');
  const lines = [
    '## Status',
    `${cards.length} cards: ${columns.map((c) => `${c.count} in ${c.name}`).join(', ')}.`,
    '',
    '## Blockers',
    blocked.length ? cite(blocked) : 'None spotted.',
    '',
    '## Overdue',
    overdue.length ? cite(overdue) : 'Nothing overdue.',
    '',
    '## Suggested next steps',
    overdue[0]
      ? `- Re-plan or close out ${overdue[0].title} [${overdue[0].ref}].`
      : '- Keep the current pace.',
  ];
  return lines.join('\n');
}

function answer(question: string, cards: MockCard[]): string {
  const terms = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const hits = cards
    .map((c) => ({ c, score: terms.filter((t) => c.text.includes(t)).length }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (hits.length === 0) return "I couldn't find anything on the board about that.";
  return `Based on the board: ${hits.map(({ c }) => `"${c.title}" is in ${c.column} [${c.ref}]`).join('; ')}.`;
}

const STOP = new Set([
  'what',
  'which',
  'who',
  'the',
  'and',
  'are',
  'about',
  'there',
  'any',
  'how',
  'for',
  'this',
  'that',
  'with',
  'is',
]);

function notesToCards(prompt: string) {
  const notes = /<notes>\n?([\s\S]*?)\n?<\/notes>/.exec(prompt)?.[1] ?? '';
  const columns = [...(/Board columns: (.*)/.exec(prompt)?.[1] ?? '').matchAll(/"([^"]*)"/g)].map(
    (m) => m[1]!,
  );
  const members = [...(/Board members: (.*)/.exec(prompt)?.[1] ?? '').matchAll(/"([^"]*)"/g)].map(
    (m) => m[1]!,
  );
  const doneCol = columns.find((c) => /done|complete/i.test(c));
  const doingCol = columns.find((c) => /progress|doing/i.test(c));
  const cards = [];
  for (const raw of notes.split('\n')) {
    const line = raw.trim();
    const isItem = /^([-*•]|\d+[.)]|\[[ x]\]|todo:?|action:?)/i.test(line) || /@\w/.test(line);
    if (!isItem || line.includes('[[mock:')) continue;
    const assignees = [...line.matchAll(/@(\w+)/g)]
      .map((m) => members.find((name) => name.toLowerCase().startsWith(m[1]!.toLowerCase())))
      .filter((n): n is string => Boolean(n));
    const labels = [...line.matchAll(/#([\w-]+)/g)].map((m) => m[1]!.toLowerCase()).slice(0, 3);
    const dueDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1] ?? null;
    const isDone = /\[x\]|\bdone\b|\bshipped\b/i.test(line);
    const isDoing = /\bin progress\b|\bwip\b|\bstarted\b/i.test(line);
    const title = line
      .replace(/^([-*•]|\d+[.)])\s*/, '')
      .replace(/^(\[[ x]\]|todo:?|action:?)\s*/i, '')
      .replace(/[@#][\w-]+/g, '')
      .replace(/\b(by|due)\s+\d{4}-\d{2}-\d{2}\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (!title) continue;
    cards.push({
      title: title[0]!.toUpperCase() + title.slice(1),
      description: `From the meeting notes: "${line.slice(0, 200)}"`,
      column: (isDone ? doneCol : isDoing ? doingCol : undefined) ?? columns[0] ?? 'To do',
      labels,
      dueDate,
      assignees,
      checklist: [],
    });
    if (cards.length >= 25) break;
  }
  return cards;
}
