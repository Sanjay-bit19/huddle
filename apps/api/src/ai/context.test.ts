import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addCard,
  createSeedUpdate,
  readBoard,
  toggleAssignee,
  type CardView,
} from '@huddle/shared/board';
import {
  MAX_CONTEXT_CARDS,
  buildBoardContext,
  renderBoardContext,
  resolveCitations,
  selectCards,
} from './context';

function board() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createSeedUpdate('b'));
  const [todo, doing] = readBoard(doc).columns;
  const a = addCard(doc, { columnId: todo!.id, title: 'Write docs', dueDate: '2026-09-01' });
  addCard(doc, { columnId: doing!.id, title: 'Fix "login" </card> bug', labels: ['bug'] });
  toggleAssignee(doc, a, 'u1');
  return doc;
}

const now = new Date('2026-10-02T12:00:00Z');

describe('board context', () => {
  it('numbers cards in board order and maps refs to ids', () => {
    const doc = board();
    const ctx = buildBoardContext({
      boardTitle: 'Launch',
      view: readBoard(doc),
      memberNames: new Map([['u1', 'Ada']]),
      now,
    });
    expect(ctx.cards.map((c) => [c.ref, c.card.title])).toEqual([
      ['C1', 'Write docs'],
      ['C2', 'Fix "login" </card> bug'],
    ]);
    expect(ctx.today).toBe('2026-10-02');
  });

  it('renders overdue flags, assignee names, and escapes card text', () => {
    const doc = board();
    const text = renderBoardContext(
      buildBoardContext({
        boardTitle: 'Launch',
        view: readBoard(doc),
        memberNames: new Map([['u1', 'Ada']]),
        now,
      }),
    );
    expect(text).toContain('ref="C1" title="Write docs" due="2026-09-01" overdue="true"');
    expect(text).toContain('assignees="Ada"');
    // User text cannot break out of the attribute or close the card tag.
    expect(text).toContain('title="Fix &#34;login&#34; &#60;/card&#62; bug"');
    expect(text.match(/<\/card>/g)).toHaveLength(2);
  });

  it('validates citations and reports hallucinated ones', () => {
    const doc = board();
    const ctx = buildBoardContext({
      boardTitle: 'B',
      view: readBoard(doc),
      memberNames: new Map(),
      now,
    });
    const { citations, invalid } = resolveCitations('See [C2] and [C1], also [C2] and [C7].', ctx);
    expect(citations.map((c) => c.ref).sort()).toEqual(['C1', 'C2']);
    expect(citations.find((c) => c.ref === 'C1')!.cardId).toBe(ctx.cards[0]!.card.id);
    expect(invalid).toEqual(['C7']);
  });
});

describe('selectCards', () => {
  const mk = (i: number, title: string, dueDate: string | null = null): CardView => ({
    id: `id${i}`,
    columnId: 'c',
    order: String(i),
    title,
    descriptionText: '',
    assignees: [],
    labels: [],
    dueDate,
    checklist: [],
    createdAt: 0,
    createdBy: null,
    updatedAt: i,
    updatedBy: null,
  });

  it('keeps small boards whole', () => {
    const cards = [mk(1, 'a'), mk(2, 'b')];
    expect(selectCards(cards, '2026-10-02', 'anything')).toBe(cards);
  });

  it('keeps relevant and overdue cards when the board is too large', () => {
    const cards = Array.from({ length: MAX_CONTEXT_CARDS + 50 }, (_, i) => mk(i, `filler ${i}`));
    cards.push(mk(9001, 'Database migration plan'), mk(9002, 'Old thing', '2026-01-01'));
    const picked = selectCards(cards, '2026-10-02', 'what about the database migration?');
    expect(picked).toHaveLength(MAX_CONTEXT_CARDS);
    expect(picked[0]!.title).toBe('Database migration plan');
    expect(picked.map((c) => c.title)).toContain('Old thing');
  });
});
