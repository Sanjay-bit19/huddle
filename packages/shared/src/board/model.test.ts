import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addCard,
  addChecklistItem,
  addColumn,
  boardRoots,
  cardDescription,
  deleteColumn,
  moveCard,
  moveColumn,
  readBoard,
  toggleAssignee,
  toggleLabel,
  updateCard,
  updateChecklistItem,
} from './model';
import { orderKeyAt } from './order';
import { createSeedUpdate } from './seed';
import { fragmentToText, setFragmentText } from './text';

/** Two replicas that exchange updates only when told to (simulates network partitions). */
function replicas(seed = createSeedUpdate('board-1')) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, seed);
  Y.applyUpdate(b, seed);
  const sync = () => {
    const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, ua);
    Y.applyUpdate(a, ub);
  };
  return { a, b, sync };
}

const titles = (doc: Y.Doc, colIndex: number) => {
  const board = readBoard(doc);
  return board.cardsByColumn.get(board.columns[colIndex]!.id)!.map((c) => c.title);
};

describe('seed', () => {
  it('creates three default columns', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeedUpdate('b'));
    expect(readBoard(doc).columns.map((c) => c.title)).toEqual(['To do', 'In progress', 'Done']);
  });

  it('is deterministic, so seeding twice never duplicates columns', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeedUpdate('b'));
    Y.applyUpdate(doc, createSeedUpdate('b'));
    // Two servers seeding concurrently, then syncing:
    const other = new Y.Doc();
    Y.applyUpdate(other, createSeedUpdate('b'));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(readBoard(doc).columns).toHaveLength(3);
    expect(createSeedUpdate('b')).toEqual(createSeedUpdate('b'));
  });
});

describe('ordering', () => {
  it('orderKeyAt places items between neighbours', () => {
    const a = orderKeyAt([], 0);
    const c = orderKeyAt([{ id: '1', order: a }], 1);
    const b = orderKeyAt(
      [
        { id: '1', order: a },
        { id: '2', order: c },
      ],
      1,
    );
    expect(a < b && b < c).toBe(true);
  });

  it('handles tied keys from concurrent inserts', () => {
    const k = orderKeyAt([], 0);
    const siblings = [
      { id: 'x', order: k },
      { id: 'y', order: k },
    ];
    const between = orderKeyAt(siblings, 1);
    expect(between > k).toBe(true);
  });
});

describe('cards', () => {
  it('adds, edits and moves cards', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeedUpdate('b'));
    const [todo, doing] = readBoard(doc).columns;
    const c1 = addCard(doc, { columnId: todo!.id, title: 'Write spec', labels: ['docs'] });
    addCard(doc, { columnId: todo!.id, title: 'Ship it' });
    addCard(doc, { columnId: todo!.id, title: 'First', index: 0 });
    expect(titles(doc, 0)).toEqual(['First', 'Write spec', 'Ship it']);

    updateCard(doc, c1, { title: 'Write the spec', dueDate: '2026-10-31' });
    toggleAssignee(doc, c1, 'user-1');
    toggleLabel(doc, c1, 'docs'); // toggles off
    toggleLabel(doc, c1, 'urgent');
    const item = addChecklistItem(doc, c1, 'Outline')!;
    updateChecklistItem(doc, c1, item, { done: true });

    moveCard(doc, c1, doing!.id, 0);
    expect(titles(doc, 0)).toEqual(['First', 'Ship it']);
    const moved = readBoard(doc).cardsByColumn.get(doing!.id)![0]!;
    expect(moved).toMatchObject({
      title: 'Write the spec',
      dueDate: '2026-10-31',
      assignees: ['user-1'],
      labels: ['urgent'],
      checklist: [expect.objectContaining({ text: 'Outline', done: true })],
    });
  });

  it('reorders within a column', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeedUpdate('b'));
    const col = readBoard(doc).columns[0]!.id;
    const ids = ['A', 'B', 'C', 'D'].map((t) => addCard(doc, { columnId: col, title: t }));
    moveCard(doc, ids[3]!, col, 0); // D to top
    moveCard(doc, ids[0]!, col, 4); // A to bottom
    expect(titles(doc, 0)).toEqual(['D', 'B', 'C', 'A']);
  });

  it('stores descriptions as rich text and extracts plain text', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeedUpdate('b'));
    const col = readBoard(doc).columns[0]!.id;
    const id = addCard(doc, { columnId: col, title: 'x', description: 'line one\nline two' });
    expect(readBoard(doc).cards[0]!.descriptionText).toBe('line one\nline two');
    const frag = cardDescription(doc, id)!;
    doc.transact(() => setFragmentText(frag, 'replaced'));
    expect(fragmentToText(frag)).toBe('replaced');
  });
});

describe('concurrent edits converge', () => {
  it('two users moving the same card to different columns: exactly one copy, same place on both', () => {
    const { a, b, sync } = replicas();
    const [todo, doing, done] = readBoard(a).columns;
    const card = addCard(a, { columnId: todo!.id, title: 'Contested' });
    sync();

    moveCard(a, card, doing!.id, 0); // offline concurrently...
    moveCard(b, card, done!.id, 0);
    sync();

    const boardA = readBoard(a);
    const boardB = readBoard(b);
    expect(boardA.cards).toHaveLength(1); // no duplication (the Y.Array failure mode)
    expect(boardA.cards[0]!.columnId).toBe(boardB.cards[0]!.columnId);
    expect([doing!.id, done!.id]).toContain(boardA.cards[0]!.columnId);
  });

  it('two users inserting at the same position keep both cards in the same order', () => {
    const { a, b, sync } = replicas();
    const col = readBoard(a).columns[0]!.id;
    addCard(a, { columnId: col, title: 'top' });
    addCard(a, { columnId: col, title: 'bottom' });
    sync();
    addCard(a, { columnId: col, title: 'from A', index: 1 });
    addCard(b, { columnId: col, title: 'from B', index: 1 });
    sync();
    expect(titles(a, 0)).toEqual(titles(b, 0));
    expect(titles(a, 0)).toHaveLength(4);
    expect(titles(a, 0)[0]).toBe('top');
    expect(titles(a, 0)[3]).toBe('bottom');
  });

  it('concurrent edits to different fields of one card both survive', () => {
    const { a, b, sync } = replicas();
    const col = readBoard(a).columns[0]!.id;
    const card = addCard(a, { columnId: col, title: 'Old' });
    sync();
    updateCard(a, card, { title: 'New title' });
    updateCard(b, card, { dueDate: '2026-12-01' });
    toggleAssignee(a, card, 'u1');
    toggleAssignee(b, card, 'u2');
    sync();
    for (const doc of [a, b]) {
      expect(readBoard(doc).cards[0]).toMatchObject({
        title: 'New title',
        dueDate: '2026-12-01',
        assignees: ['u1', 'u2'],
      });
    }
  });

  it('concurrent rich-text typing merges character-level', () => {
    const { a, b, sync } = replicas();
    const col = readBoard(a).columns[0]!.id;
    const card = addCard(a, { columnId: col, title: 't', description: 'hello' });
    sync();
    const textA = cardDescription(a, card)!.get(0) as Y.XmlElement;
    const textB = cardDescription(b, card)!.get(0) as Y.XmlElement;
    (textA.get(0) as Y.XmlText).insert(5, ' world');
    (textB.get(0) as Y.XmlText).insert(0, 'oh, ');
    sync();
    expect(readBoard(a).cards[0]!.descriptionText).toBe('oh, hello world');
    expect(readBoard(b).cards[0]!.descriptionText).toBe('oh, hello world');
  });

  it('a card moved into a concurrently deleted column is not lost', () => {
    const { a, b, sync } = replicas();
    const [todo, doing] = readBoard(a).columns;
    const card = addCard(a, { columnId: todo!.id, title: 'Survivor' });
    sync();
    moveCard(a, card, doing!.id, 0);
    deleteColumn(b, doing!.id);
    sync();
    for (const doc of [a, b]) {
      const board = readBoard(doc);
      expect(board.columns.map((c) => c.title)).toEqual(['To do', 'Done']);
      expect(board.cards.map((c) => c.title)).toEqual(['Survivor']);
      expect(board.cards[0]!.columnId).toBe(todo!.id);
    }
  });

  it('concurrent column reorders converge', () => {
    const { a, b, sync } = replicas();
    const cols = readBoard(a).columns;
    moveColumn(a, cols[0]!.id, 2);
    moveColumn(b, cols[2]!.id, 0);
    addColumn(a, 'Backlog', 0);
    sync();
    expect(readBoard(a).columns.map((c) => c.id)).toEqual(readBoard(b).columns.map((c) => c.id));
    expect(readBoard(a).columns).toHaveLength(4);
  });

  it('deleting a column removes its cards', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeedUpdate('b'));
    const [todo] = readBoard(doc).columns;
    addCard(doc, { columnId: todo!.id, title: 'gone' });
    deleteColumn(doc, todo!.id);
    expect(boardRoots(doc).cards.size).toBe(0);
  });
});
