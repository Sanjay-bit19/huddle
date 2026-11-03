import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ActivityTracker, describeActivity, type ActivityItem } from './activity';
import {
  addCard,
  addChecklistItem,
  addColumn,
  boardRoots,
  cardDescription,
  deleteCard,
  deleteColumn,
  moveCard,
  moveColumn,
  readBoard,
  renameColumn,
  toggleAssignee,
  toggleLabel,
  updateCard,
  updateChecklistItem,
} from './model';
import { createSeedUpdate } from './seed';

function setup() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createSeedUpdate('b'));
  const tracker = new ActivityTracker(doc);
  const log: ActivityItem[][] = [];
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    log.push(tracker.derive(tr));
    tracker.refresh();
  });
  const [todo, doing, done] = readBoard(doc).columns;
  const last = () => log.at(-1)!;
  return { doc, log, last, todo: todo!.id, doing: doing!.id, done: done!.id };
}

describe('ActivityTracker', () => {
  it('describes card lifecycle', () => {
    const { doc, last, todo, done } = setup();
    const id = addCard(doc, {
      columnId: todo,
      title: 'Write spec',
      description: 'x',
      checklist: ['a'],
    });
    // Creating a card is one entry, not one per field.
    expect(last()).toEqual([
      { type: 'card.created', cardId: id, data: { title: 'Write spec', column: 'To do' } },
    ]);

    moveCard(doc, id, done, 0);
    expect(last()).toEqual([
      { type: 'card.moved', cardId: id, data: { title: 'Write spec', from: 'To do', to: 'Done' } },
    ]);

    updateCard(doc, id, { title: 'Write the spec' });
    expect(last()).toContainEqual({
      type: 'card.renamed',
      cardId: id,
      data: { from: 'Write spec', to: 'Write the spec' },
    });

    deleteCard(doc, id);
    expect(last()).toEqual([
      { type: 'card.deleted', cardId: id, data: { title: 'Write the spec' } },
    ]);
  });

  it('ignores reorders within a column', () => {
    const { doc, last, todo } = setup();
    const a = addCard(doc, { columnId: todo, title: 'a' });
    addCard(doc, { columnId: todo, title: 'b' });
    moveCard(doc, a, todo, 2);
    expect(last().filter((i) => i.type === 'card.moved')).toEqual([]);
  });

  it('describes field, set and checklist changes', () => {
    const { doc, last, todo } = setup();
    const id = addCard(doc, { columnId: todo, title: 'Card' });
    updateCard(doc, id, { dueDate: '2026-12-01' });
    expect(last()).toContainEqual({
      type: 'card.due_changed',
      cardId: id,
      data: { title: 'Card', from: null, to: '2026-12-01' },
    });
    toggleAssignee(doc, id, 'user-1');
    expect(last()).toContainEqual({
      type: 'card.assigned',
      cardId: id,
      data: { title: 'Card', userId: 'user-1' },
    });
    toggleAssignee(doc, id, 'user-1');
    expect(last()).toContainEqual({
      type: 'card.unassigned',
      cardId: id,
      data: { title: 'Card', userId: 'user-1' },
    });
    toggleLabel(doc, id, 'bug');
    expect(last()).toContainEqual({
      type: 'card.labeled',
      cardId: id,
      data: { title: 'Card', label: 'bug' },
    });
    const item = addChecklistItem(doc, id, 'Write tests')!;
    expect(last()).toContainEqual({
      type: 'checklist.item_added',
      cardId: id,
      data: { title: 'Card', item: 'Write tests' },
    });
    updateChecklistItem(doc, id, item, { done: true });
    expect(last()).toContainEqual({
      type: 'checklist.item_checked',
      cardId: id,
      data: { title: 'Card', item: 'Write tests' },
    });
  });

  it('collapses rich-text edits to one entry per transaction', () => {
    const { doc, last, todo } = setup();
    const id = addCard(doc, { columnId: todo, title: 'Card', description: 'hello' });
    const text = (cardDescription(doc, id)!.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    doc.transact(() => {
      text.insert(5, ' world');
      text.format(0, 5, { bold: true });
    });
    expect(last()).toEqual([
      { type: 'card.description_edited', cardId: id, data: { title: 'Card' } },
    ]);
  });

  it('describes column changes', () => {
    const { doc, last, todo, done } = setup();
    const col = addColumn(doc, 'Backlog');
    expect(last()).toEqual([{ type: 'column.created', cardId: null, data: { column: 'Backlog' } }]);
    renameColumn(doc, todo, 'Next');
    expect(last()).toEqual([
      { type: 'column.renamed', cardId: null, data: { from: 'To do', to: 'Next' } },
    ]);
    moveColumn(doc, col, 0);
    expect(last()).toEqual([{ type: 'column.moved', cardId: null, data: { column: 'Backlog' } }]);
    deleteColumn(doc, done);
    expect(last()).toEqual([{ type: 'column.deleted', cardId: null, data: { column: 'Done' } }]);
  });

  it('attributes remote (applied) updates the same way', () => {
    const { doc, last, todo } = setup();
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const id = addCard(other, { columnId: todo, title: 'From afar' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), 'remote');
    expect(last()).toEqual([
      { type: 'card.created', cardId: id, data: { title: 'From afar', column: 'To do' } },
    ]);
    expect(boardRoots(doc).cards.size).toBe(1);
  });
});

describe('describeActivity', () => {
  it('renders sentences', () => {
    expect(describeActivity('card.moved', { title: 'Ship', from: 'To do', to: 'Done' })).toBe(
      'moved "Ship" from To do to Done',
    );
    expect(describeActivity('card.due_changed', { title: 'Ship', to: null })).toBe(
      'cleared the due date of "Ship"',
    );
  });
});
