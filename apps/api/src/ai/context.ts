import { CITATION_PATTERN, type Citation } from '@huddle/shared';
import type { BoardView, CardView } from '@huddle/shared/board';

/**
 * Grounding: the board is rendered into the prompt as data, and every card
 * gets a short reference (C1, C2, ...). The model cites cards by reference;
 * the server maps references back to real card ids and drops any reference
 * that does not exist (a hallucinated citation never reaches the UI as a link).
 *
 * Short refs instead of UUIDs: fewer tokens, and a model is far less likely
 * to garble "C12" than a 36-character id.
 */

export interface ContextCard {
  ref: string;
  card: CardView;
  columnTitle: string;
}

export interface BoardContext {
  boardTitle: string;
  today: string;
  columns: Array<{ id: string; title: string }>;
  cards: ContextCard[];
  /** Cards left out because the board is larger than the context budget. */
  omitted: number;
  memberNames: Map<string, string>;
}

export const MAX_CONTEXT_CARDS = 200;
const MAX_DESCRIPTION_CHARS = 400;

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

/**
 * Picks the cards to include. Small boards go in whole. Large boards keep
 * the cards most relevant to the question (keyword overlap), plus overdue
 * cards, which status questions almost always care about.
 */
export function selectCards(cards: CardView[], today: string, question?: string): CardView[] {
  if (cards.length <= MAX_CONTEXT_CARDS) return cards;
  const terms = new Set(tokenize(question ?? ''));
  const score = (c: CardView) => {
    const words = tokenize(`${c.title} ${c.descriptionText} ${c.labels.join(' ')}`);
    let s = words.filter((w) => terms.has(w)).length * 10;
    if (c.dueDate && c.dueDate < today) s += 5;
    return s + c.updatedAt / 1e13; // tie-break: recently updated first
  };
  return [...cards].sort((a, b) => score(b) - score(a)).slice(0, MAX_CONTEXT_CARDS);
}

export function buildBoardContext(input: {
  boardTitle: string;
  view: BoardView;
  memberNames: Map<string, string>;
  question?: string;
  now?: Date;
}): BoardContext {
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const { view } = input;
  const selected = new Set(selectCards(view.cards, today, input.question).map((c) => c.id));
  const cards: ContextCard[] = [];
  let n = 0;
  for (const col of view.columns) {
    for (const card of view.cardsByColumn.get(col.id) ?? []) {
      if (!selected.has(card.id)) continue;
      cards.push({ ref: `C${++n}`, card, columnTitle: col.title });
    }
  }
  return {
    boardTitle: input.boardTitle,
    today,
    columns: view.columns.map((c) => ({ id: c.id, title: c.title })),
    cards,
    omitted: view.cards.length - cards.length,
    memberNames: input.memberNames,
  };
}

const attr = (s: string) => s.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const body = (s: string) => s.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));

/** XML-ish rendering. Card text is escaped so it cannot close our tags. */
export function renderBoardContext(ctx: BoardContext): string {
  const lines = [`<board title="${attr(ctx.boardTitle)}" today="${ctx.today}">`];
  for (const col of ctx.columns) {
    const inCol = ctx.cards.filter((c) => c.card.columnId === col.id);
    lines.push(`<column name="${attr(col.title)}" cards="${inCol.length}">`);
    for (const { ref, card } of inCol) {
      const attrs = [`ref="${ref}"`, `title="${attr(card.title)}"`];
      if (card.dueDate) {
        attrs.push(`due="${card.dueDate}"`);
        if (card.dueDate < ctx.today) attrs.push('overdue="true"');
      }
      if (card.labels.length) attrs.push(`labels="${attr(card.labels.join(', '))}"`);
      if (card.assignees.length) {
        const names = card.assignees.map((id) => ctx.memberNames.get(id) ?? 'unknown member');
        attrs.push(`assignees="${attr(names.join(', '))}"`);
      }
      if (card.checklist.length) {
        attrs.push(
          `checklist="${card.checklist.filter((i) => i.done).length}/${card.checklist.length} done"`,
        );
      }
      const desc = card.descriptionText.slice(0, MAX_DESCRIPTION_CHARS);
      lines.push(`  <card ${attrs.join(' ')}>${body(desc)}</card>`);
    }
    lines.push('</column>');
  }
  if (ctx.omitted > 0) lines.push(`<!-- ${ctx.omitted} less relevant cards omitted -->`);
  lines.push('</board>');
  return lines.join('\n');
}

/** Validates the references a model used; unknown ones are reported as invalid. */
export function resolveCitations(
  text: string,
  ctx: BoardContext,
): { citations: Citation[]; invalid: string[] } {
  const byRef = new Map(ctx.cards.map((c) => [c.ref, c]));
  const citations = new Map<string, Citation>();
  const invalid = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const ref = match[1]!;
    const hit = byRef.get(ref);
    if (hit) citations.set(ref, { ref, cardId: hit.card.id, title: hit.card.title });
    else invalid.add(ref);
  }
  return { citations: [...citations.values()], invalid: [...invalid] };
}
