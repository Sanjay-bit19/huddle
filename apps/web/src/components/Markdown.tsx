import { Fragment, type ReactNode } from 'react';
import type { Citation } from '@huddle/shared';

/**
 * Tiny Markdown renderer for AI output: headings, bullet lists, paragraphs,
 * **bold** and [C12] citations. It builds React elements (never innerHTML),
 * so model output cannot inject markup. Citations become links only when the
 * server validated them; unknown references render as struck-through text.
 */
export function Markdown({
  text,
  citations,
  invalid = [],
  onCite,
}: {
  text: string;
  citations: Map<string, Citation> | null;
  invalid?: string[];
  onCite: (cardId: string) => void;
}) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={`ul${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-5">
          {list}
        </ul>,
      );
      list = [];
    }
  };

  const inline = (line: string, key: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*|\[C\d{1,4}\])/g).map((part, i) => {
      const k = `${key}-${i}`;
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      const cite = /^\[(C\d{1,4})\]$/.exec(part);
      if (cite) {
        const ref = cite[1]!;
        const hit = citations?.get(ref);
        if (hit) {
          return (
            <button
              key={k}
              onClick={() => onCite(hit.cardId)}
              title={`Open "${hit.title}"`}
              className="mx-0.5 rounded bg-indigo-50 px-1 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100"
              data-testid="citation"
            >
              {ref}
            </button>
          );
        }
        if (invalid.includes(ref)) {
          return (
            <span key={k} className="text-slate-400 line-through" title="Not a card on this board">
              {ref}
            </span>
          );
        }
      }
      return <Fragment key={k}>{part}</Fragment>;
    });

  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push(
        <h4 key={i} className="mt-3 mb-1 text-sm font-semibold text-slate-800 first:mt-0">
          {inline(heading[2]!, `h${i}`)}
        </h4>,
      );
    } else if (bullet) {
      list.push(<li key={i}>{inline(bullet[1]!, `li${i}`)}</li>);
    } else if (line.trim()) {
      flushList();
      blocks.push(
        <p key={i} className="my-1">
          {inline(line, `p${i}`)}
        </p>,
      );
    } else {
      flushList();
    }
  });
  flushList();
  return <div className="text-sm leading-relaxed text-slate-700">{blocks}</div>;
}
