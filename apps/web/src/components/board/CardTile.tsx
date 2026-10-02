import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { memo } from 'react';
import type { CardView } from '@huddle/shared/board';
import type { PresenceUser } from '@huddle/shared';
import { Avatar } from '../ui';
import { LabelChip } from './labels';

export interface MemberLite {
  userId: string;
  name: string;
}

export function dueStatus(dueDate: string | null): 'overdue' | 'soon' | 'later' | null {
  if (!dueDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return 'overdue';
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  return dueDate <= soon ? 'soon' : 'later';
}

const dueClass = {
  overdue: 'bg-rose-50 text-rose-700 ring-rose-200',
  soon: 'bg-amber-50 text-amber-700 ring-amber-200',
  later: 'bg-slate-50 text-slate-600 ring-slate-200',
};

export const CardFace = memo(function CardFace({
  card,
  members,
  editors,
  movers,
  highlighted,
}: {
  card: CardView;
  members: Map<string, string>;
  editors?: PresenceUser[];
  movers?: PresenceUser[];
  highlighted?: boolean;
}) {
  const done = card.checklist.filter((i) => i.done).length;
  const due = dueStatus(card.dueDate);
  const editing = editors ?? [];
  const moving = movers ?? [];
  const accent = moving[0] ?? editing[0];
  return (
    <div
      className={`relative rounded-lg bg-white p-3 text-left shadow-xs ring-1 transition ${
        highlighted ? 'ring-2 ring-indigo-500' : 'ring-slate-200 hover:ring-slate-300'
      } ${moving.length > 0 ? 'opacity-60' : ''}`}
      style={accent ? { boxShadow: `0 0 0 2px ${accent.color}` } : undefined}
    >
      {card.labels.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {card.labels.map((l) => (
            <LabelChip key={l} label={l} />
          ))}
        </div>
      ) : null}
      <div className="text-sm leading-snug font-medium break-words text-slate-800">
        {card.title || <span className="text-slate-400 italic">Untitled</span>}
      </div>
      {due || card.checklist.length > 0 || card.assignees.length > 0 || card.descriptionText ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
          {due ? (
            <span className={`rounded px-1.5 py-0.5 font-medium ring-1 ${dueClass[due]}`}>
              {due === 'overdue' ? 'Overdue · ' : ''}
              {new Date(card.dueDate + 'T00:00:00').toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          ) : null}
          {card.checklist.length > 0 ? (
            <span className={done === card.checklist.length ? 'text-emerald-600' : ''}>
              ☑ {done}/{card.checklist.length}
            </span>
          ) : null}
          {card.descriptionText ? <span title="Has description">≡</span> : null}
          <span className="ml-auto flex -space-x-1.5">
            {card.assignees.slice(0, 3).map((id) => (
              <Avatar key={id} id={id} name={members.get(id) ?? '?'} size={20} ring />
            ))}
          </span>
        </div>
      ) : null}
      {moving.length > 0 || editing.length > 0 ? (
        <div
          className="absolute -top-2.5 right-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
          style={{ background: accent!.color }}
          data-testid="editing-indicator"
        >
          {moving.length > 0
            ? `${moving.map((u) => u.name.split(' ')[0]).join(', ')} moving`
            : `${editing.map((u) => u.name.split(' ')[0]).join(', ')} editing`}
        </div>
      ) : null}
    </div>
  );
});

export function SortableCard({
  card,
  members,
  editors,
  movers,
  disabled,
  onOpen,
}: {
  card: CardView;
  members: Map<string, string>;
  editors?: PresenceUser[];
  movers?: PresenceUser[];
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `card:${card.id}`,
    data: { type: 'card', cardId: card.id, columnId: card.columnId },
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'opacity-40' : ''}
      data-testid="card"
      data-card-id={card.id}
    >
      <div
        {...attributes}
        {...listeners}
        aria-label={`Card: ${card.title}. Press Enter to open, Space to move.`}
        onClick={() => onOpen(card.id)}
        onKeyDown={(e) => {
          // Space starts a keyboard drag (dnd-kit); Enter opens the card.
          if (e.key === 'Enter') {
            e.preventDefault();
            onOpen(card.id);
            return;
          }
          listeners?.onKeyDown?.(e);
        }}
        className="cursor-grab rounded-lg focus-visible:outline-2 focus-visible:outline-indigo-500 active:cursor-grabbing"
      >
        <CardFace card={card} members={members} editors={editors} movers={movers} />
      </div>
    </li>
  );
}
