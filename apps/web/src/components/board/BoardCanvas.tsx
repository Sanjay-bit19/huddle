import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type * as Y from 'yjs';
import type { PresenceUser } from '@huddle/shared';
import {
  addCard,
  addColumn,
  deleteColumn,
  moveCard,
  moveColumn,
  renameColumn,
  type BoardView,
  type CardView,
  type ColumnView,
} from '@huddle/shared/board';
import { CardFace, SortableCard } from './CardTile';

type Items = Record<string, string[]>; // columnId -> card ids (render order)

const cardKey = (id: string) => `card:${id}`;
const colKey = (id: string) => `col:${id}`;
const parseKey = (key: UniqueIdentifier) => {
  const [type, ...rest] = String(key).split(':');
  return { type: type as 'card' | 'col', id: rest.join(':') };
};

function itemsFromView(view: BoardView): Items {
  const items: Items = {};
  for (const col of view.columns) {
    items[col.id] = (view.cardsByColumn.get(col.id) ?? []).map((c) => c.id);
  }
  return items;
}

/**
 * Cards may land on other cards or on a column (empty column / below the
 * last card); columns may only land on columns.
 */
const collisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type;
  if (activeType === 'column') {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => c.data.current?.type === 'column',
      ),
    });
  }
  return closestCorners(args);
};

/**
 * Keyboard moves: Up/Down reorder within a column (standard sortable
 * behaviour); Left/Right jump a card straight to the neighbouring column,
 * which the generic geometry-based getter does unreliably for kanban layouts.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const { active, collisionRect, droppableRects, droppableContainers } = args.context;
  const horizontal = event.code === 'ArrowRight' || event.code === 'ArrowLeft';
  if (horizontal && active?.data.current?.type === 'card' && collisionRect) {
    const columns = droppableContainers
      .getEnabled()
      .filter((c) => c.data.current?.type === 'column')
      .map((c) => ({ id: c.id, rect: droppableRects.get(c.id) }))
      .filter((c): c is { id: UniqueIdentifier; rect: NonNullable<typeof c.rect> } => !!c.rect)
      .sort((a, b) => a.rect.left - b.rect.left);
    const centerX = collisionRect.left + collisionRect.width / 2;
    let current = 0;
    columns.forEach((c, i) => {
      const d = Math.abs(c.rect.left + c.rect.width / 2 - centerX);
      const best = columns[current]!;
      if (d < Math.abs(best.rect.left + best.rect.width / 2 - centerX)) current = i;
    });
    const target = columns[current + (event.code === 'ArrowRight' ? 1 : -1)];
    if (!target) return undefined;
    event.preventDefault();
    return {
      x: target.rect.left + (target.rect.width - collisionRect.width) / 2,
      y: target.rect.top + 44, // just below the column header: top of its list
    };
  }
  return sortableKeyboardCoordinates(event, args);
};

export function BoardCanvas({
  doc,
  view,
  readOnly,
  userId,
  members,
  editorsByCard,
  onOpenCard,
  onDragCard,
  overlay,
}: {
  doc: Y.Doc;
  view: BoardView;
  readOnly: boolean;
  userId: string;
  members: Map<string, string>;
  editorsByCard: Map<string, PresenceUser[]>;
  onOpenCard: (cardId: string) => void;
  onDragCard?: (cardId: string | null) => void;
  overlay?: ReactNode;
}) {
  const sensors = useSensors(
    // A small distance threshold keeps plain clicks (open card) working.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  // While dragging we render from a local copy so the card can preview its
  // new column; the CRDT is written once, on drop.
  const [dragItems, setDragItems] = useState<Items | null>(null);
  const [active, setActive] = useState<{ type: 'card' | 'col'; id: string } | null>(null);
  const items = dragItems ?? itemsFromView(view);
  const cardsById = useMemo(() => new Map(view.cards.map((c) => [c.id, c])), [view.cards]);
  const columnsById = useMemo(() => new Map(view.columns.map((c) => [c.id, c])), [view.columns]);
  const actor = { userId };
  const announceRef = useRef<Items | null>(null);

  const findColumn = (key: UniqueIdentifier, from: Items): string | undefined => {
    const { type, id } = parseKey(key);
    if (type === 'col') return id;
    return Object.keys(from).find((colId) => from[colId]!.includes(id));
  };

  const onDragStart = ({ active: a }: DragStartEvent) => {
    const parsed = parseKey(a.id);
    setActive(parsed);
    if (parsed.type === 'card') {
      const snapshot = itemsFromView(view);
      setDragItems(snapshot);
      announceRef.current = snapshot;
      onDragCard?.(parsed.id);
    }
  };

  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    if (!over || parseKey(a.id).type !== 'card' || !dragItems) return;
    const from = findColumn(a.id, dragItems);
    const to = findColumn(over.id, dragItems);
    if (!from || !to || from === to) return;
    const cardId = parseKey(a.id).id;
    setDragItems((prev) => {
      if (!prev) return prev;
      const source = prev[from]!.filter((id) => id !== cardId);
      const target = [...prev[to]!];
      const overParsed = parseKey(over.id);
      const overIndex = overParsed.type === 'card' ? target.indexOf(overParsed.id) : target.length;
      target.splice(overIndex < 0 ? target.length : overIndex, 0, cardId);
      return { ...prev, [from]: source, [to]: target };
    });
  };

  const finish = () => {
    setActive(null);
    setDragItems(null);
    onDragCard?.(null);
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    const parsed = parseKey(a.id);
    if (!over) return finish();

    if (parsed.type === 'col') {
      const overCol = findColumn(over.id, items);
      const ids = view.columns.map((c) => c.id);
      if (overCol && overCol !== parsed.id) {
        moveColumn(doc, parsed.id, ids.indexOf(overCol));
      }
      return finish();
    }

    const current = dragItems ?? itemsFromView(view);
    const to = findColumn(over.id, current);
    if (to) {
      const list = current[to]!.filter((id) => id !== parsed.id);
      const overParsed = parseKey(over.id);
      let index = list.length;
      if (overParsed.type === 'card' && overParsed.id !== parsed.id) {
        const overIndex = list.indexOf(overParsed.id);
        const original = current[to]!.indexOf(parsed.id);
        const overOriginal = current[to]!.indexOf(overParsed.id);
        // Moving down within the list lands after the hovered card.
        index = overIndex + (original !== -1 && original < overOriginal ? 1 : 0);
      } else if (overParsed.type === 'card') {
        index = current[to]!.indexOf(parsed.id);
      }
      const card = cardsById.get(parsed.id);
      const prevIndex = card ? (itemsFromView(view)[card.columnId] ?? []).indexOf(card.id) : -1;
      if (!card || card.columnId !== to || prevIndex !== index) {
        moveCard(doc, parsed.id, to, Math.max(0, index), actor);
      }
    }
    finish();
  };

  const nameOf = (key: UniqueIdentifier) => {
    const { type, id } = parseKey(key);
    return type === 'card'
      ? `card "${cardsById.get(id)?.title ?? ''}"`
      : `column "${columnsById.get(id)?.title ?? ''}"`;
  };
  const positionOf = (key: UniqueIdentifier) => {
    const col = findColumn(key, items);
    if (!col) return '';
    const { type, id } = parseKey(key);
    const colTitle = columnsById.get(col)?.title ?? '';
    if (type === 'col')
      return `column ${view.columns.findIndex((c) => c.id === col) + 1} of ${view.columns.length}`;
    return `position ${items[col]!.indexOf(id) + 1} of ${items[col]!.length} in ${colTitle}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up ${nameOf(a.id)}.`,
    onDragOver: ({ active: a, over }) =>
      over
        ? `${nameOf(a.id)} is over ${positionOf(over.id) || nameOf(over.id)}.`
        : `${nameOf(a.id)} is no longer over a drop area.`,
    onDragEnd: ({ active: a, over }) =>
      over
        ? `Dropped ${nameOf(a.id)} at ${positionOf(over.id) || nameOf(over.id)}.`
        : `Dropped ${nameOf(a.id)}.`,
    onDragCancel: ({ active: a }) =>
      `Cancelled. ${nameOf(a.id)} returned to its original position.`,
  };

  const activeCard = active?.type === 'card' ? cardsById.get(active.id) : undefined;
  const activeColumn = active?.type === 'col' ? columnsById.get(active.id) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To pick up a card or column, press Space. Use the arrow keys to move it, Space or Enter to drop, Escape to cancel. Press Enter on a card to open it.',
        },
      }}
    >
      <div className="relative flex h-full items-start gap-4 overflow-x-auto p-4" data-board-scroll>
        <SortableContext
          items={view.columns.map((c) => colKey(c.id))}
          strategy={horizontalListSortingStrategy}
        >
          {view.columns.map((col) => (
            <SortableColumn
              key={col.id}
              column={col}
              count={items[col.id]?.length ?? 0}
              readOnly={readOnly}
              doc={doc}
            >
              <SortableContext
                items={(items[col.id] ?? []).map(cardKey)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex min-h-12 flex-col gap-2" aria-label={`Cards in ${col.title}`}>
                  {(items[col.id] ?? []).map((id) => {
                    const card = cardsById.get(id);
                    if (!card) return null;
                    return (
                      <SortableCard
                        key={id}
                        card={card}
                        members={members}
                        editors={editorsByCard.get(id)}
                        disabled={readOnly}
                        onOpen={onOpenCard}
                      />
                    );
                  })}
                </ul>
              </SortableContext>
              {!readOnly ? (
                <AddCard onAdd={(title) => addCard(doc, { columnId: col.id, title }, actor)} />
              ) : null}
            </SortableColumn>
          ))}
        </SortableContext>
        {!readOnly ? <AddColumn onAdd={(title) => addColumn(doc, title)} /> : null}
        {overlay}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="w-72 rotate-2 cursor-grabbing">
            <CardFace card={activeCard} members={members} highlighted />
          </div>
        ) : activeColumn ? (
          <div className="w-72 rounded-xl bg-slate-100/90 p-3 font-semibold shadow-lg ring-2 ring-indigo-500">
            {activeColumn.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableColumn({
  column,
  count,
  readOnly,
  doc,
  children,
}: {
  column: ColumnView;
  count: number;
  readOnly: boolean;
  doc: Y.Doc;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: colKey(column.id),
    data: { type: 'column', columnId: column.id },
    disabled: readOnly,
  });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(column.title);

  const commit = () => {
    setEditing(false);
    if (title.trim() && title !== column.title) renameColumn(doc, column.id, title);
    else setTitle(column.title);
  };

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex max-h-full w-72 shrink-0 flex-col rounded-xl bg-slate-100 ${isDragging ? 'opacity-40' : ''}`}
      aria-label={`Column ${column.title}`}
      data-testid="column"
      data-column-title={column.title}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        {!readOnly ? (
          <button
            {...attributes}
            {...listeners}
            aria-label={`Move column ${column.title}`}
            className="cursor-grab rounded px-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            ⋮⋮
          </button>
        ) : null}
        {editing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded px-1 text-sm font-semibold ring-1 ring-indigo-400"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setTitle(column.title);
                setEditing(false);
              }
            }}
            aria-label="Column title"
          />
        ) : (
          <h2
            className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700"
            onDoubleClick={() => !readOnly && (setTitle(column.title), setEditing(true))}
          >
            {column.title}
          </h2>
        )}
        <span className="rounded-full bg-slate-200 px-2 text-xs font-medium text-slate-600">
          {count}
        </span>
        {!readOnly ? (
          <button
            className="rounded px-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600"
            aria-label={`Delete column ${column.title}`}
            onClick={() => {
              if (confirm(`Delete column "${column.title}" and its ${count} cards?`))
                deleteColumn(doc, column.id);
            }}
          >
            🗑
          </button>
        ) : null}
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-3">{children}</div>
    </section>
  );
}

function AddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title);
    setTitle('');
  };
  if (!open) {
    return (
      <button
        className="mt-2 w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-200 hover:text-slate-700"
        onClick={() => setOpen(true)}
      >
        + Add card
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      <textarea
        autoFocus
        aria-label="New card title"
        className="block w-full resize-none rounded-md border-0 p-2 text-sm shadow-xs ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500"
        rows={2}
        maxLength={200}
        placeholder="What needs doing?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
        >
          Add
        </button>
        <button type="button" className="text-xs text-slate-500" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddColumn({ onAdd }: { onAdd: (title: string) => void }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className="w-72 shrink-0 rounded-xl border-2 border-dashed border-slate-200 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onAdd(title);
        setTitle('');
      }}
    >
      <input
        aria-label="New column title"
        className="w-full rounded-md bg-transparent px-2 py-1.5 text-sm placeholder:text-slate-400 focus:bg-white focus:ring-1 focus:ring-indigo-400"
        placeholder="+ Add column"
        maxLength={120}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
    </form>
  );
}

export type { CardView };
