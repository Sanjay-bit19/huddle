import { useState, type FormEvent } from 'react';
import { can, type Role } from '@huddle/shared';
import { timeAgo, useAddComment, useComments, useDeleteComment } from '../../lib/board-data';
import { Avatar, Button, ErrorBanner, Spinner } from '../ui';

export function Comments({
  boardId,
  cardId,
  role,
  userId,
}: {
  boardId: string;
  cardId: string;
  role: Role;
  userId: string;
}) {
  const comments = useComments(boardId, cardId);
  const add = useAddComment(boardId, cardId);
  const remove = useDeleteComment(boardId, cardId);
  const [body, setBody] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    await add.mutateAsync(body);
    setBody('');
  };

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Comments
      </h3>
      {comments.isPending ? <Spinner /> : null}
      <ul className="space-y-3" data-testid="comments">
        {(comments.data ?? []).map((c) => (
          <li key={c.id} className="group flex gap-2">
            {c.author ? <Avatar id={c.author.id} name={c.author.name} size={24} /> : null}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="font-semibold text-slate-800">
                  {c.author?.name ?? 'Former member'}
                </span>
                <span className="text-slate-400">{timeAgo(c.createdAt)}</span>
                {c.author?.id === userId || can(role, 'comment:moderate') ? (
                  <button
                    className="ml-auto hidden text-slate-400 group-hover:inline hover:text-rose-600"
                    onClick={() => remove.mutate(c.id)}
                    aria-label="Delete comment"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
              <p className="mt-0.5 text-sm whitespace-pre-wrap text-slate-700">{c.body}</p>
            </div>
          </li>
        ))}
      </ul>
      {can(role, 'comment:create') ? (
        <form onSubmit={submit} className="mt-3 space-y-2">
          <textarea
            aria-label="Write a comment"
            className="block w-full resize-y rounded-md border-0 p-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500"
            rows={2}
            maxLength={4000}
            placeholder="Write a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
          />
          <ErrorBanner error={add.error} />
          <Button type="submit" size="sm" disabled={!body.trim() || add.isPending}>
            Comment
          </Button>
        </form>
      ) : null}
    </section>
  );
}
