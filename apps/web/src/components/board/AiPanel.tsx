import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type * as Y from 'yjs';
import type { CardProposal, Citation } from '@huddle/shared';
import { addCard, type ColumnView } from '@huddle/shared/board';
import { ApiError } from '../../lib/api';
import { aiStatusKey, notesToCards, streamAi, useAiStatus } from '../../lib/ai';
import { Markdown } from '../Markdown';
import { Button, ErrorBanner, Spinner } from '../ui';
import { LabelChip } from './labels';

type Tab = 'summary' | 'ask' | 'notes';

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'ai_budget_exceeded') {
      const resets = (err.body as { error?: { details?: { resetsAt?: string } } })?.error?.details
        ?.resetsAt;
      return `${err.message}.${resets ? ` It resets on ${new Date(resets).toLocaleDateString()}.` : ''}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function AiPanel({
  boardId,
  doc,
  columns,
  userId,
  canWrite,
  onOpenCard,
  onClose,
}: {
  boardId: string;
  doc: Y.Doc;
  columns: ColumnView[];
  userId: string;
  canWrite: boolean;
  onOpenCard: (cardId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('summary');
  const status = useAiStatus();
  const budget = status.data?.budget;
  const tabs: Array<[Tab, string]> = [
    ['summary', 'Summarize'],
    ['ask', 'Ask'],
    ...(canWrite ? ([['notes', 'Notes → cards']] as Array<[Tab, string]>) : []),
  ];

  return (
    <aside
      className="flex h-full w-[420px] shrink-0 flex-col border-l border-slate-200 bg-white"
      aria-label="AI assistant"
      data-testid="ai-panel"
    >
      <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <span className="text-base">✨</span>
        <h2 className="font-semibold">AI assist</h2>
        {status.data?.provider === 'mock' ? (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
            title="AI_PROVIDER=mock: a deterministic offline stand-in. Set AI_PROVIDER=anthropic for Claude."
          >
            MOCK AI
          </span>
        ) : status.data ? (
          <span className="text-[11px] text-slate-400">{status.data.model}</span>
        ) : null}
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100"
          aria-label="Close AI panel"
        >
          ✕
        </button>
      </header>
      <div role="tablist" className="flex gap-1 px-4 pt-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
              tab === id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'summary' ? (
          <StreamTab boardId={boardId} feature="summary" onOpenCard={onOpenCard} />
        ) : null}
        {tab === 'ask' ? (
          <StreamTab boardId={boardId} feature="ask" onOpenCard={onOpenCard} />
        ) : null}
        {tab === 'notes' ? (
          <NotesTab boardId={boardId} doc={doc} columns={columns} userId={userId} />
        ) : null}
      </div>
      {budget ? (
        <footer
          className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500"
          data-testid="ai-budget"
        >
          <div className="mb-1 flex justify-between">
            <span>Monthly AI budget</span>
            <span>
              {budget.used.toLocaleString()} / {budget.limit.toLocaleString()} tokens
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded bg-slate-100">
            <div
              className={`h-full ${budget.used / budget.limit > 0.9 ? 'bg-rose-500' : 'bg-indigo-500'}`}
              style={{ width: `${Math.min(100, (budget.used / budget.limit) * 100)}%` }}
            />
          </div>
        </footer>
      ) : null}
    </aside>
  );
}

function StreamTab({
  boardId,
  feature,
  onOpenCard,
}: {
  boardId: string;
  feature: 'summary' | 'ask';
  onOpenCard: (cardId: string) => void;
}) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState('');
  const [text, setText] = useState('');
  const [citations, setCitations] = useState<Map<string, Citation> | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [state, setState] = useState<'idle' | 'streaming' | 'done'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setText('');
    setCitations(null);
    setInvalid([]);
    setNotice(null);
    setError(null);
    setState('streaming');
    try {
      await streamAi(
        `/api/boards/${boardId}/ai/${feature}`,
        feature === 'ask' ? { question } : {},
        (event) => {
          switch (event.event) {
            case 'delta':
              setText((t) => t + event.data.text);
              break;
            case 'citations':
              setCitations(new Map(event.data.citations.map((c) => [c.ref, c])));
              setInvalid(event.data.invalid);
              break;
            case 'refusal':
              setText('');
              setNotice(event.data.message);
              break;
            case 'done':
              if (event.data.truncated) setNotice('The answer was cut off at the length limit.');
              break;
            case 'error':
              setError(event.data.message);
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(friendlyError(err));
    } finally {
      setState('done');
      void qc.invalidateQueries({ queryKey: aiStatusKey });
    }
  };

  return (
    <div className="space-y-3">
      {feature === 'ask' ? (
        <form onSubmit={run} className="flex gap-2">
          <input
            aria-label="Question about this board"
            className="min-w-0 flex-1 rounded-md border-0 px-3 py-1.5 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500"
            placeholder="What's blocking the launch?"
            maxLength={500}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!question.trim() || state === 'streaming'}>
            Ask
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void run()} disabled={state === 'streaming'}>
            {state === 'idle' ? 'Summarize this board' : 'Regenerate'}
          </Button>
          <span className="text-xs text-slate-500">Status, blockers and overdue items</span>
        </div>
      )}
      {state === 'streaming' ? (
        <div className="flex items-center justify-between">
          <Spinner label={text ? 'Writing…' : 'Reading the board…'} />
          <button
            className="text-xs text-slate-500 hover:text-slate-700"
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </button>
        </div>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}
      {notice ? (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          {notice}
        </div>
      ) : null}
      {text ? (
        <div data-testid={`ai-${feature}-output`}>
          <Markdown text={text} citations={citations} invalid={invalid} onCite={onOpenCard} />
        </div>
      ) : null}
    </div>
  );
}

interface Draft extends CardProposal {
  selected: boolean;
}

function NotesTab({
  boardId,
  doc,
  columns,
  userId,
}: {
  boardId: string;
  doc: Y.Doc;
  columns: ColumnView[];
  userId: string;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    setAdded(null);
    try {
      const res = await notesToCards(boardId, notes);
      setDrafts(res.proposals.map((p) => ({ ...p, selected: true })));
      setWarnings(res.warnings);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(false);
      void qc.invalidateQueries({ queryKey: aiStatusKey });
    }
  };

  const accept = () => {
    if (!drafts) return;
    const chosen = drafts.filter((d) => d.selected && d.title.trim());
    // Inserted through the CRDT as the current user: the collab server applies
    // the same permission checks and validation as any manual edit.
    doc.transact(() => {
      for (const d of chosen) {
        addCard(
          doc,
          {
            columnId: d.columnId,
            title: d.title,
            description: d.description,
            labels: d.labels,
            assignees: d.assignees.map((a) => a.userId),
            dueDate: d.dueDate,
            checklist: d.checklist,
          },
          { userId },
        );
      }
    });
    setAdded(chosen.length);
    setDrafts(null);
    setNotes('');
  };

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds && ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  if (drafts) {
    const count = drafts.filter((d) => d.selected).length;
    return (
      <div className="space-y-3" data-testid="ai-proposals">
        <p className="text-xs text-slate-500">
          Review before anything is added. Uncheck, rename or move cards as needed.
        </p>
        {warnings.length ? (
          <ul className="space-y-0.5 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-amber-200">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {drafts.length === 0 ? (
          <p className="text-sm text-slate-500">No action items found in those notes.</p>
        ) : null}
        <ul className="space-y-2">
          {drafts.map((d, i) => (
            <li
              key={i}
              className={`rounded-lg p-2.5 ring-1 ${d.selected ? 'ring-indigo-200' : 'opacity-50 ring-slate-200'}`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={d.selected}
                  aria-label={`Include ${d.title}`}
                  onChange={(e) => update(i, { selected: e.target.checked })}
                  className="mt-1.5"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <input
                    aria-label="Proposed card title"
                    className="w-full rounded border-0 px-1.5 py-0.5 text-sm font-medium ring-1 ring-slate-200 focus:ring-indigo-500"
                    value={d.title}
                    maxLength={200}
                    onChange={(e) => update(i, { title: e.target.value })}
                  />
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                    <select
                      aria-label="Column"
                      className="rounded border-0 py-0 pr-6 pl-1.5 text-[11px] ring-1 ring-slate-200"
                      value={d.columnId}
                      onChange={(e) => update(i, { columnId: e.target.value })}
                    >
                      {columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                    {d.labels.map((l) => (
                      <LabelChip key={l} label={l} />
                    ))}
                    {d.dueDate ? <span>due {d.dueDate}</span> : null}
                    {d.assignees.length ? (
                      <span>→ {d.assignees.map((a) => a.name).join(', ')}</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button onClick={accept} disabled={count === 0}>
            Add {count} card{count === 1 ? '' : 's'}
          </Button>
          <Button variant="secondary" onClick={() => setDrafts(null)}>
            Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {added !== null ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
          Added {added} card{added === 1 ? '' : 's'} to the board.
        </div>
      ) : null}
      <textarea
        aria-label="Meeting notes"
        className="block h-56 w-full resize-y rounded-md border-0 p-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500"
        placeholder={
          'Paste meeting notes…\n\n- Ada to write the launch post by 2026-10-20 #marketing\n- @Bob fix the flaky login test #bug'
        }
        maxLength={20_000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {error ? <ErrorBanner error={error} /> : null}
      <Button type="submit" disabled={!notes.trim() || pending}>
        {pending ? 'Reading notes…' : 'Propose cards'}
      </Button>
    </form>
  );
}
