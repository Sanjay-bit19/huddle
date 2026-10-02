import { useState, type ReactNode } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import type { PresenceUser } from '@huddle/shared';
import {
  addChecklistItem,
  cardDescription,
  deleteCard,
  deleteChecklistItem,
  toggleAssignee,
  toggleLabel,
  updateCard,
  updateChecklistItem,
  type CardView,
} from '@huddle/shared/board';
import { Avatar, Button, Modal } from '../ui';
import { DescriptionEditor } from './DescriptionEditor';
import { LabelChip } from './labels';

export interface CardDetailProps {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  card: CardView;
  columnTitle: string;
  readOnly: boolean;
  me: PresenceUser;
  members: Array<{ userId: string; name: string }>;
  otherEditors: PresenceUser[];
  onClose: () => void;
  /** Slots for later features (comments, activity). */
  footer?: ReactNode;
}

export function CardDetail(props: CardDetailProps) {
  const { doc, provider, card, readOnly, me, members, otherEditors, onClose } = props;
  const actor = { userId: me.id };
  const fragment = cardDescription(doc, card.id);

  return (
    <Modal title={card.title || 'Card'} onClose={onClose} wide>
      <div className="grid gap-6 md:grid-cols-[1fr_220px]">
        <div className="min-w-0 space-y-5">
          {otherEditors.length > 0 ? (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800 ring-1 ring-amber-200">
              {otherEditors.map((u) => (
                <Avatar key={u.id} id={u.id} name={u.name} size={18} />
              ))}
              {otherEditors.map((u) => u.name).join(', ')}{' '}
              {otherEditors.length === 1 ? 'is' : 'are'} also editing this card
            </div>
          ) : null}
          <TitleField
            value={card.title}
            readOnly={readOnly}
            onCommit={(title) => updateCard(doc, card.id, { title }, actor)}
          />
          <p className="-mt-3 text-xs text-slate-500">in {props.columnTitle}</p>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Description
            </h3>
            {fragment ? (
              <DescriptionEditor
                fragment={fragment}
                provider={provider}
                user={me}
                editable={!readOnly}
              />
            ) : null}
          </section>

          <Checklist doc={doc} card={card} readOnly={readOnly} actor={actor} />
          {props.footer}
        </div>

        <aside className="space-y-5 text-sm">
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Due date
            </h3>
            <input
              type="date"
              aria-label="Due date"
              disabled={readOnly}
              className="w-full rounded-md border-0 px-2 py-1.5 text-sm ring-1 ring-slate-300 disabled:bg-slate-50"
              value={card.dueDate ?? ''}
              onChange={(e) => updateCard(doc, card.id, { dueDate: e.target.value || null }, actor)}
            />
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Assignees
            </h3>
            <ul className="space-y-1">
              {members.map((m) => {
                const assigned = card.assignees.includes(m.userId);
                return (
                  <li key={m.userId}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={assigned}
                        disabled={readOnly}
                        onChange={() => toggleAssignee(doc, card.id, m.userId, actor)}
                      />
                      <Avatar id={m.userId} name={m.name} size={20} />
                      <span className="truncate">{m.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <Labels doc={doc} card={card} readOnly={readOnly} actor={actor} />

          {!readOnly ? (
            <Button
              variant="secondary"
              size="sm"
              className="w-full text-rose-600"
              onClick={() => {
                if (!confirm('Delete this card?')) return;
                deleteCard(doc, card.id);
                onClose();
              }}
            >
              Delete card
            </Button>
          ) : null}
        </aside>
      </div>
    </Modal>
  );
}

function TitleField({
  value,
  readOnly,
  onCommit,
}: {
  value: string;
  readOnly: boolean;
  onCommit: (v: string) => void;
}) {
  // While focused we edit a local draft; otherwise we show the live value so
  // a collaborator's rename appears immediately.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <textarea
      aria-label="Card title"
      rows={1}
      maxLength={200}
      readOnly={readOnly}
      className="w-full resize-none rounded-md border-0 px-2 py-1 text-lg font-semibold ring-slate-200 hover:ring-1 focus:ring-2 focus:ring-indigo-500"
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

function Checklist({
  doc,
  card,
  readOnly,
  actor,
}: {
  doc: Y.Doc;
  card: CardView;
  readOnly: boolean;
  actor: { userId: string };
}) {
  const [text, setText] = useState('');
  const done = card.checklist.filter((i) => i.done).length;
  return (
    <section>
      <h3 className="mb-1.5 flex items-center justify-between text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Checklist
        {card.checklist.length > 0 ? (
          <span className="font-normal normal-case">
            {done}/{card.checklist.length}
          </span>
        ) : null}
      </h3>
      {card.checklist.length > 0 ? (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${(done / card.checklist.length) * 100}%` }}
          />
        </div>
      ) : null}
      <ul className="space-y-1">
        {card.checklist.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={item.text}
              checked={item.done}
              disabled={readOnly}
              onChange={(e) =>
                updateChecklistItem(doc, card.id, item.id, { done: e.target.checked }, actor)
              }
            />
            <span className={`flex-1 ${item.done ? 'text-slate-400 line-through' : ''}`}>
              {item.text}
            </span>
            {!readOnly ? (
              <button
                className="hidden text-xs text-slate-400 group-hover:inline hover:text-rose-600"
                aria-label={`Delete ${item.text}`}
                onClick={() => deleteChecklistItem(doc, card.id, item.id, actor)}
              >
                ✕
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            addChecklistItem(doc, card.id, text, actor);
            setText('');
          }}
        >
          <input
            aria-label="New checklist item"
            className="w-full rounded-md border-0 px-2 py-1 text-sm ring-1 ring-slate-200 focus:ring-indigo-500"
            placeholder="+ Add an item"
            maxLength={300}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
      ) : null}
    </section>
  );
}

function Labels({
  doc,
  card,
  readOnly,
  actor,
}: {
  doc: Y.Doc;
  card: CardView;
  readOnly: boolean;
  actor: { userId: string };
}) {
  const [text, setText] = useState('');
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Labels
      </h3>
      <div className="flex flex-wrap gap-1">
        {card.labels.map((l) => (
          <LabelChip
            key={l}
            label={l}
            onRemove={readOnly ? undefined : () => toggleLabel(doc, card.id, l, actor)}
          />
        ))}
        {card.labels.length === 0 ? <span className="text-xs text-slate-400">None</span> : null}
      </div>
      {!readOnly ? (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            const label = text.trim().toLowerCase();
            if (label && !card.labels.includes(label)) toggleLabel(doc, card.id, label, actor);
            setText('');
          }}
        >
          <input
            aria-label="Add label"
            className="w-full rounded-md border-0 px-2 py-1 text-xs ring-1 ring-slate-200 focus:ring-indigo-500"
            placeholder="+ Add label"
            maxLength={32}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
      ) : null}
    </section>
  );
}
