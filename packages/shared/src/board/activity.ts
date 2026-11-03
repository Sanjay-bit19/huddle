import type * as Y from 'yjs';
import { boardRoots, type CardPos } from './model';

/**
 * Activity log derived from Yjs transactions.
 *
 * A transaction lists every shared type it changed (`changedParentTypes`)
 * with Yjs events that say which map keys were added / updated / deleted and
 * their old values. This turns those low-level changes into semantic entries
 * ("moved X from To do to Done"). The collab server runs it only for
 * transactions that came from a client connection, so the actor is known and
 * each change is recorded once, by the node that received it.
 */

export const ACTIVITY_TYPES = [
  'card.created',
  'card.deleted',
  'card.moved',
  'card.renamed',
  'card.due_changed',
  'card.assigned',
  'card.unassigned',
  'card.labeled',
  'card.unlabeled',
  'card.description_edited',
  'checklist.item_added',
  'checklist.item_removed',
  'checklist.item_checked',
  'checklist.item_unchecked',
  'column.created',
  'column.renamed',
  'column.deleted',
  'column.moved',
  'comment.added',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityItem {
  type: ActivityType;
  cardId: string | null;
  data: Record<string, string | null>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// Yjs shared types are invariant in their event type parameter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyType = Y.AbstractType<any>;

/**
 * Path of `target` below `root` as map keys (array positions are -1).
 * Computed explicitly: Yjs' event.path is only root-relative when a deep
 * observer is registered on that root.
 */
function pathBelow(root: AnyType, target: AnyType): Array<string | number> | null {
  const path: Array<string | number> = [];
  let t: AnyType = target;
  while (t !== root) {
    const item = t._item;
    if (!item) return null;
    path.unshift(item.parentSub ?? -1);
    t = item.parent as AnyType;
  }
  return path;
}

/**
 * Keeps titles of cards and columns as they were before the current
 * transaction, so deletions and moves can be described by name.
 */
export class ActivityTracker {
  private cardTitles = new Map<string, string>();
  private columnTitles = new Map<string, string>();

  constructor(private readonly doc: Y.Doc) {
    this.refresh();
  }

  refresh(): void {
    const { cards, columns } = boardRoots(this.doc);
    this.cardTitles.clear();
    cards.forEach((card, id) => this.cardTitles.set(id, str(card.get('title')) ?? ''));
    this.columnTitles.clear();
    columns.forEach((col, id) => this.columnTitles.set(id, str(col.get('title')) ?? ''));
  }

  private columnName(id: string | null | undefined): string | null {
    if (!id) return null;
    return (
      str(boardRoots(this.doc).columns.get(id)?.get('title')) ?? this.columnTitles.get(id) ?? null
    );
  }

  private cardTitle(id: string): string {
    return str(boardRoots(this.doc).cards.get(id)?.get('title')) ?? this.cardTitles.get(id) ?? '';
  }

  /** Describes one transaction. Call from doc.on('afterTransaction'). */
  derive(transaction: Y.Transaction): ActivityItem[] {
    const { cards, columns } = boardRoots(this.doc);
    const items: ActivityItem[] = [];
    const created = new Set<string>();

    const columnsRoot = columns as AnyType;
    for (const event of transaction.changedParentTypes.get(columnsRoot) ?? []) {
      const path = pathBelow(columnsRoot, event.target as AnyType);
      if (!path) continue;
      if (path.length === 0) {
        event.changes.keys.forEach((change, id) => {
          if (change.action === 'add') {
            items.push({
              type: 'column.created',
              cardId: null,
              data: { column: this.columnName(id) },
            });
          } else if (change.action === 'delete') {
            items.push({
              type: 'column.deleted',
              cardId: null,
              data: { column: this.columnTitles.get(id) ?? null },
            });
          }
        });
      } else if (path.length === 1) {
        const id = String(path[0]);
        event.changes.keys.forEach((change, key) => {
          if (key === 'title' && change.action === 'update') {
            items.push({
              type: 'column.renamed',
              cardId: null,
              data: { from: str(change.oldValue), to: this.columnName(id) },
            });
          } else if (key === 'order' && change.action === 'update') {
            items.push({
              type: 'column.moved',
              cardId: null,
              data: { column: this.columnName(id) },
            });
          }
        });
      }
    }

    const cardsRoot = cards as AnyType;
    for (const event of transaction.changedParentTypes.get(cardsRoot) ?? []) {
      const path = pathBelow(cardsRoot, event.target as AnyType);
      if (!path) continue;
      const cardId = typeof path[0] === 'string' ? path[0] : null;

      if (path.length === 0) {
        event.changes.keys.forEach((change, id) => {
          if (change.action === 'add') {
            created.add(id);
            const pos = boardRoots(this.doc).cards.get(id)?.get('pos') as CardPos | undefined;
            items.push({
              type: 'card.created',
              cardId: id,
              data: { title: this.cardTitle(id), column: this.columnName(pos?.columnId) },
            });
          } else if (change.action === 'delete') {
            items.push({
              type: 'card.deleted',
              cardId: id,
              data: { title: this.cardTitles.get(id) ?? null },
            });
          }
        });
        continue;
      }
      if (!cardId || created.has(cardId)) continue; // a new card's own fields are not news
      const title = this.cardTitle(cardId);
      const field = path[1];

      if (path.length === 1) {
        event.changes.keys.forEach((change, key) => {
          if (change.action !== 'update' && change.action !== 'add') return;
          const card = boardRoots(this.doc).cards.get(cardId);
          if (key === 'title') {
            items.push({
              type: 'card.renamed',
              cardId,
              data: { from: str(change.oldValue), to: title },
            });
          } else if (key === 'pos') {
            const before = change.oldValue as CardPos | undefined;
            const after = card?.get('pos') as CardPos | undefined;
            // Reordering inside a column is noise; only column changes are logged.
            if (before?.columnId && after?.columnId && before.columnId !== after.columnId) {
              items.push({
                type: 'card.moved',
                cardId,
                data: {
                  title,
                  from: this.columnName(before.columnId),
                  to: this.columnName(after.columnId),
                },
              });
            }
          } else if (key === 'dueDate') {
            items.push({
              type: 'card.due_changed',
              cardId,
              data: { title, from: str(change.oldValue), to: str(card?.get('dueDate')) },
            });
          }
        });
      } else if ((field === 'assignees' || field === 'labels') && path.length === 2) {
        event.changes.keys.forEach((change, key) => {
          if (change.action === 'update') return;
          const added = change.action === 'add';
          items.push(
            field === 'assignees'
              ? {
                  type: added ? 'card.assigned' : 'card.unassigned',
                  cardId,
                  data: { title, userId: key },
                }
              : {
                  type: added ? 'card.labeled' : 'card.unlabeled',
                  cardId,
                  data: { title, label: key },
                },
          );
        });
      } else if (field === 'checklist' && path.length === 2) {
        event.changes.keys.forEach((change, itemId) => {
          if (change.action === 'add') {
            const item = (
              boardRoots(this.doc).cards.get(cardId)?.get('checklist') as Y.Map<Y.Map<unknown>>
            )?.get(itemId);
            items.push({
              type: 'checklist.item_added',
              cardId,
              data: { title, item: str(item?.get('text')) },
            });
          } else if (change.action === 'delete') {
            items.push({ type: 'checklist.item_removed', cardId, data: { title, item: null } });
          }
        });
      } else if (field === 'checklist' && path.length === 3) {
        const item = event.target as Y.Map<unknown>;
        event.changes.keys.forEach((change, key) => {
          if (key !== 'done' || change.action !== 'update') return;
          items.push({
            type: item.get('done') === true ? 'checklist.item_checked' : 'checklist.item_unchecked',
            cardId,
            data: { title, item: str(item.get('text')) },
          });
        });
      } else if (field === 'description') {
        items.push({ type: 'card.description_edited', cardId, data: { title } });
      }
    }

    return dedupe(items);
  }
}

/** One description edit per card per transaction (rich text emits several events). */
function dedupe(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (i.type !== 'card.description_edited') return true;
    const key = `${i.type}:${i.cardId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Human-readable sentence for an activity entry (actor name prepended by the UI). */
export function describeActivity(type: ActivityType, d: Record<string, string | null>): string {
  const q = (s: string | null | undefined) => `"${s ?? 'untitled'}"`;
  switch (type) {
    case 'card.created':
      return `added ${q(d.title)}${d.column ? ` to ${d.column}` : ''}`;
    case 'card.deleted':
      return `deleted ${q(d.title)}`;
    case 'card.moved':
      return `moved ${q(d.title)} from ${d.from ?? '?'} to ${d.to ?? '?'}`;
    case 'card.renamed':
      return `renamed ${q(d.from)} to ${q(d.to)}`;
    case 'card.due_changed':
      return d.to
        ? `set the due date of ${q(d.title)} to ${d.to}`
        : `cleared the due date of ${q(d.title)}`;
    case 'card.assigned':
      return `assigned someone to ${q(d.title)}`;
    case 'card.unassigned':
      return `unassigned someone from ${q(d.title)}`;
    case 'card.labeled':
      return `labeled ${q(d.title)} "${d.label}"`;
    case 'card.unlabeled':
      return `removed label "${d.label}" from ${q(d.title)}`;
    case 'card.description_edited':
      return `edited the description of ${q(d.title)}`;
    case 'checklist.item_added':
      return `added "${d.item}" to the checklist of ${q(d.title)}`;
    case 'checklist.item_removed':
      return `removed a checklist item from ${q(d.title)}`;
    case 'checklist.item_checked':
      return `completed "${d.item}" on ${q(d.title)}`;
    case 'checklist.item_unchecked':
      return `reopened "${d.item}" on ${q(d.title)}`;
    case 'column.created':
      return `added column ${q(d.column)}`;
    case 'column.renamed':
      return `renamed column ${q(d.from)} to ${q(d.to)}`;
    case 'column.deleted':
      return `deleted column ${q(d.column)}`;
    case 'column.moved':
      return `reordered column ${q(d.column)}`;
    case 'comment.added':
      return `commented on ${q(d.title)}`;
  }
}
