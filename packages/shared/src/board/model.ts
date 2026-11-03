import * as Y from 'yjs';
import { orderKeyAt, sortOrdered } from './order';
import { fragmentToText, setFragmentText } from './text';

/**
 * Board document layout (one Y.Doc per board):
 *
 *   doc.getMap('columns')  id -> Y.Map { id, title, order, createdAt }
 *   doc.getMap('cards')    id -> Y.Map {
 *       id, title, pos: { columnId, order },   // pos is ONE value: atomic move
 *       description: Y.XmlFragment,            // rich text (TipTap/ProseMirror)
 *       assignees: Y.Map<true>, labels: Y.Map<true>,   // CRDT sets
 *       dueDate: 'YYYY-MM-DD' | null,
 *       checklist: Y.Map<Y.Map { id, text, done, order }>,
 *       createdAt, createdBy, updatedAt, updatedBy }
 *   doc.getMap('meta')     { schemaVersion }
 *
 * Why maps keyed by id instead of arrays: concurrent edits to different cards
 * never interact, and a move is a single field write (see order.ts).
 *
 * Why `pos` is one object rather than `columnId` + `order` fields: a move must
 * be atomic. Two concurrent moves of the same card resolve to exactly one of
 * the two destinations (last-writer-wins on one key), never a mix of A's
 * column with B's order.
 */

export const BOARD_SCHEMA_VERSION = 1;

export type YColumn = Y.Map<unknown>;
export type YCard = Y.Map<unknown>;

export interface CardPos {
  columnId: string;
  order: string;
}

export interface ColumnView {
  id: string;
  title: string;
  order: string;
}

export interface ChecklistItemView {
  id: string;
  text: string;
  done: boolean;
  order: string;
}

export interface CardView {
  id: string;
  columnId: string;
  order: string;
  title: string;
  descriptionText: string;
  assignees: string[];
  labels: string[];
  dueDate: string | null;
  checklist: ChecklistItemView[];
  createdAt: number;
  createdBy: string | null;
  updatedAt: number;
  updatedBy: string | null;
}

export interface BoardView {
  columns: ColumnView[];
  /** Cards grouped by column id, sorted. Orphans land in the first column. */
  cardsByColumn: Map<string, CardView[]>;
  cards: CardView[];
}

export const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export function boardRoots(doc: Y.Doc) {
  return {
    columns: doc.getMap<YColumn>('columns'),
    cards: doc.getMap<YCard>('cards'),
    meta: doc.getMap<unknown>('meta'),
  };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function readPos(card: YCard): CardPos | null {
  const pos = card.get('pos') as Partial<CardPos> | undefined;
  if (!pos || typeof pos.columnId !== 'string' || typeof pos.order !== 'string') return null;
  return { columnId: pos.columnId, order: pos.order };
}

function setKeys(map: unknown): string[] {
  return map instanceof Y.Map ? [...map.keys()].sort() : [];
}

export function readColumn(col: YColumn): ColumnView {
  return { id: str(col.get('id')), title: str(col.get('title')), order: str(col.get('order')) };
}

export function readChecklist(card: YCard): ChecklistItemView[] {
  const list = card.get('checklist');
  if (!(list instanceof Y.Map)) return [];
  const items: ChecklistItemView[] = [];
  list.forEach((item: unknown) => {
    if (!(item instanceof Y.Map)) return;
    items.push({
      id: str(item.get('id')),
      text: str(item.get('text')),
      done: item.get('done') === true,
      order: str(item.get('order')),
    });
  });
  return sortOrdered(items);
}

export function readCard(card: YCard, fallbackColumnId = ''): CardView {
  const pos = readPos(card);
  const description = card.get('description');
  const dueDate = card.get('dueDate');
  return {
    id: str(card.get('id')),
    columnId: pos?.columnId ?? fallbackColumnId,
    order: pos?.order ?? '',
    title: str(card.get('title')),
    descriptionText: description instanceof Y.XmlFragment ? fragmentToText(description) : '',
    assignees: setKeys(card.get('assignees')),
    labels: setKeys(card.get('labels')),
    dueDate: typeof dueDate === 'string' ? dueDate : null,
    checklist: readChecklist(card),
    createdAt: num(card.get('createdAt')),
    createdBy: (card.get('createdBy') as string | undefined) ?? null,
    updatedAt: num(card.get('updatedAt')),
    updatedBy: (card.get('updatedBy') as string | undefined) ?? null,
  };
}

export function readBoard(doc: Y.Doc): BoardView {
  const { columns, cards } = boardRoots(doc);
  const cols = sortOrdered([...columns.values()].map(readColumn));
  const colIds = new Set(cols.map((c) => c.id));
  const byColumn = new Map<string, CardView[]>(cols.map((c) => [c.id, []]));
  const all: CardView[] = [];
  const firstCol = cols[0]?.id;

  cards.forEach((ycard) => {
    const card = readCard(ycard);
    // A card can reference a column that was deleted concurrently with a move
    // into it. Rather than losing it, show it at the end of the first column.
    if (!colIds.has(card.columnId)) {
      if (!firstCol) return;
      card.columnId = firstCol;
      card.order = '￿' + card.order;
    }
    byColumn.get(card.columnId)!.push(card);
    all.push(card);
  });
  for (const [id, list] of byColumn) byColumn.set(id, sortOrdered(list));
  return { columns: cols, cardsByColumn: byColumn, cards: all };
}

// ---------------------------------------------------------------------------
// Mutations. Each runs in one transaction so it is applied (and synced) atomically.
// ---------------------------------------------------------------------------

export interface Actor {
  userId: string;
}

export function initBoard(doc: Y.Doc, columnTitles = ['To do', 'In progress', 'Done']): void {
  const { meta, columns } = boardRoots(doc);
  doc.transact(() => {
    if (meta.get('schemaVersion') === undefined) meta.set('schemaVersion', BOARD_SCHEMA_VERSION);
    if (columns.size > 0) return;
    for (const title of columnTitles) {
      const siblings = sortOrdered([...columns.values()].map(readColumn));
      const id = newId();
      columns.set(id, makeColumn(id, title, orderKeyAt(siblings, siblings.length)));
    }
  });
}

function makeColumn(id: string, title: string, order: string): YColumn {
  const col = new Y.Map<unknown>();
  col.set('id', id);
  col.set('title', title);
  col.set('order', order);
  col.set('createdAt', Date.now());
  return col;
}

export function addColumn(doc: Y.Doc, title: string, index?: number): string {
  const { columns } = boardRoots(doc);
  const id = newId();
  doc.transact(() => {
    const siblings = sortOrdered([...columns.values()].map(readColumn));
    columns.set(
      id,
      makeColumn(id, title.trim().slice(0, 120), orderKeyAt(siblings, index ?? siblings.length)),
    );
  });
  return id;
}

export function renameColumn(doc: Y.Doc, columnId: string, title: string): void {
  const col = boardRoots(doc).columns.get(columnId);
  if (!col) return;
  doc.transact(() => col.set('title', title.trim().slice(0, 120)));
}

export function moveColumn(doc: Y.Doc, columnId: string, toIndex: number): void {
  const { columns } = boardRoots(doc);
  const col = columns.get(columnId);
  if (!col) return;
  const siblings = sortOrdered([...columns.values()].map(readColumn)).filter(
    (c) => c.id !== columnId,
  );
  doc.transact(() => col.set('order', orderKeyAt(siblings, toIndex)));
}

/** Deletes a column and the cards currently in it. */
export function deleteColumn(doc: Y.Doc, columnId: string): void {
  const { columns, cards } = boardRoots(doc);
  doc.transact(() => {
    cards.forEach((card, id) => {
      if (readPos(card)?.columnId === columnId) cards.delete(id);
    });
    columns.delete(columnId);
  });
}

export interface NewCardInput {
  columnId: string;
  title: string;
  description?: string;
  labels?: string[];
  assignees?: string[];
  dueDate?: string | null;
  checklist?: string[];
  /** Insert position within the column; defaults to the end. */
  index?: number;
}

function cardsInColumn(doc: Y.Doc, columnId: string, excludeId?: string) {
  const { cards } = boardRoots(doc);
  const list: { id: string; order: string }[] = [];
  cards.forEach((card, id) => {
    const pos = readPos(card);
    if (pos?.columnId === columnId && id !== excludeId) list.push({ id, order: pos.order });
  });
  return sortOrdered(list);
}

export function addCard(doc: Y.Doc, input: NewCardInput, actor?: Actor): string {
  const { cards } = boardRoots(doc);
  const id = newId();
  doc.transact(() => {
    const siblings = cardsInColumn(doc, input.columnId);
    const card = new Y.Map<unknown>();
    const now = Date.now();
    card.set('id', id);
    card.set('title', input.title.trim().slice(0, 200));
    card.set('pos', {
      columnId: input.columnId,
      order: orderKeyAt(siblings, input.index ?? siblings.length),
    } satisfies CardPos);
    const description = new Y.XmlFragment();
    card.set('description', description);
    const assignees = new Y.Map<true>();
    for (const a of input.assignees ?? []) assignees.set(a, true);
    card.set('assignees', assignees);
    const labels = new Y.Map<true>();
    for (const l of input.labels ?? []) labels.set(l.slice(0, 32), true);
    card.set('labels', labels);
    card.set('dueDate', input.dueDate ?? null);
    const checklist = new Y.Map<Y.Map<unknown>>();
    card.set('checklist', checklist);
    card.set('createdAt', now);
    card.set('createdBy', actor?.userId ?? null);
    card.set('updatedAt', now);
    card.set('updatedBy', actor?.userId ?? null);
    cards.set(id, card);
    // Nested types must be integrated into the doc before they are edited.
    // Always start with one (possibly empty) paragraph. If the fragment were
    // empty, every editor that opens the card would create its own first
    // paragraph and two people typing at once would land on separate lines.
    setFragmentText(description, (input.description ?? '').slice(0, 5000));
    let prevItems: { id: string; order: string }[] = [];
    for (const text of input.checklist ?? []) {
      const itemId = newId();
      const order = orderKeyAt(prevItems, prevItems.length);
      checklist.set(itemId, makeChecklistItem(itemId, text, order));
      prevItems = [...prevItems, { id: itemId, order }];
    }
  });
  return id;
}

function touch(card: YCard, actor?: Actor) {
  card.set('updatedAt', Date.now());
  if (actor) card.set('updatedBy', actor.userId);
}

export function getCard(doc: Y.Doc, cardId: string): YCard | undefined {
  return boardRoots(doc).cards.get(cardId);
}

export function updateCard(
  doc: Y.Doc,
  cardId: string,
  patch: { title?: string; dueDate?: string | null },
  actor?: Actor,
): void {
  const card = getCard(doc, cardId);
  if (!card) return;
  doc.transact(() => {
    if (patch.title !== undefined) card.set('title', patch.title.trim().slice(0, 200));
    if (patch.dueDate !== undefined) card.set('dueDate', patch.dueDate);
    touch(card, actor);
  });
}

export function moveCard(
  doc: Y.Doc,
  cardId: string,
  toColumnId: string,
  toIndex: number,
  actor?: Actor,
): void {
  const card = getCard(doc, cardId);
  if (!card) return;
  doc.transact(() => {
    const siblings = cardsInColumn(doc, toColumnId, cardId);
    card.set('pos', {
      columnId: toColumnId,
      order: orderKeyAt(siblings, toIndex),
    } satisfies CardPos);
    touch(card, actor);
  });
}

export function deleteCard(doc: Y.Doc, cardId: string): void {
  const { cards } = boardRoots(doc);
  doc.transact(() => cards.delete(cardId));
}

function toggleInSet(
  doc: Y.Doc,
  cardId: string,
  field: 'assignees' | 'labels',
  key: string,
  actor?: Actor,
) {
  const card = getCard(doc, cardId);
  const set = card?.get(field);
  if (!card || !(set instanceof Y.Map)) return;
  doc.transact(() => {
    if (set.has(key)) set.delete(key);
    else set.set(key, true);
    touch(card, actor);
  });
}

export const toggleAssignee = (doc: Y.Doc, cardId: string, userId: string, actor?: Actor) =>
  toggleInSet(doc, cardId, 'assignees', userId, actor);

export const toggleLabel = (doc: Y.Doc, cardId: string, label: string, actor?: Actor) =>
  toggleInSet(doc, cardId, 'labels', label.trim().slice(0, 32), actor);

function makeChecklistItem(id: string, text: string, order: string) {
  const item = new Y.Map<unknown>();
  item.set('id', id);
  item.set('text', text.trim().slice(0, 300));
  item.set('done', false);
  item.set('order', order);
  return item;
}

export function addChecklistItem(
  doc: Y.Doc,
  cardId: string,
  text: string,
  actor?: Actor,
): string | null {
  const card = getCard(doc, cardId);
  const list = card?.get('checklist');
  if (!card || !(list instanceof Y.Map)) return null;
  const id = newId();
  doc.transact(() => {
    const siblings = readChecklist(card);
    list.set(id, makeChecklistItem(id, text, orderKeyAt(siblings, siblings.length)));
    touch(card, actor);
  });
  return id;
}

export function updateChecklistItem(
  doc: Y.Doc,
  cardId: string,
  itemId: string,
  patch: { text?: string; done?: boolean },
  actor?: Actor,
): void {
  const card = getCard(doc, cardId);
  const list = card?.get('checklist');
  const item = list instanceof Y.Map ? list.get(itemId) : undefined;
  if (!card || !(item instanceof Y.Map)) return;
  doc.transact(() => {
    if (patch.text !== undefined) item.set('text', patch.text.trim().slice(0, 300));
    if (patch.done !== undefined) item.set('done', patch.done);
    touch(card, actor);
  });
}

export function deleteChecklistItem(
  doc: Y.Doc,
  cardId: string,
  itemId: string,
  actor?: Actor,
): void {
  const card = getCard(doc, cardId);
  const list = card?.get('checklist');
  if (!card || !(list instanceof Y.Map)) return;
  doc.transact(() => {
    list.delete(itemId);
    touch(card, actor);
  });
}

/** The card's rich-text description, for binding an editor to. */
export function cardDescription(doc: Y.Doc, cardId: string): Y.XmlFragment | null {
  const d = getCard(doc, cardId)?.get('description');
  return d instanceof Y.XmlFragment ? d : null;
}
