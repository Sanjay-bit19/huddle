import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSearch } from '../lib/board-data';

/** Renders ts_headline's <<match>> markers as <mark>, without any HTML injection. */
function Highlighted({ text }: { text: string }) {
  return (
    <>
      {text.split(/(<<.*?>>)/g).map((part, i) =>
        part.startsWith('<<') && part.endsWith('>>') ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-slate-900">
            {part.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchBox({ workspaceId }: { workspaceId: string }) {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);

  // Debounce keystrokes so each one does not hit the API.
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 180);
    return () => clearTimeout(t);
  }, [input]);

  const results = useSearch(workspaceId, q);
  const hits = results.data ?? [];

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    setOpen(false);
    navigate(`/b/${hit.boardId}?card=${encodeURIComponent(hit.cardId)}`);
  };

  return (
    <div ref={box} className="relative w-full max-w-xs">
      <input
        role="combobox"
        aria-expanded={open && q.length > 0}
        aria-controls="search-results"
        aria-label="Search cards in this workspace"
        placeholder="Search cards…"
        className="w-full rounded-md border-0 bg-slate-100 px-3 py-1.5 text-sm placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-indigo-500"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter') go(active);
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && q ? (
        <ul
          id="search-results"
          role="listbox"
          className="absolute z-40 mt-1 max-h-96 w-[28rem] overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-slate-200"
          data-testid="search-results"
        >
          {results.isFetching && hits.length === 0 ? (
            <li className="px-3 py-2 text-xs text-slate-400">Searching…</li>
          ) : hits.length === 0 ? (
            <li className="px-3 py-2 text-xs text-slate-400">No cards match “{q}”</li>
          ) : (
            hits.map((hit, i) => (
              <li key={`${hit.boardId}:${hit.cardId}`} role="option" aria-selected={i === active}>
                <button
                  className={`block w-full px-3 py-2 text-left ${i === active ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(i)}
                >
                  <div className="text-sm font-medium text-slate-800">{hit.title}</div>
                  <div className="truncate text-xs text-slate-500">
                    <Highlighted text={hit.snippet} />
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    {hit.boardTitle} · {hit.columnTitle}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
