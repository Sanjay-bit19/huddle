import { describeActivity, type ActivityType } from '@huddle/shared/board';
import { timeAgo, useActivityFeed, type ActivityDto } from '../../lib/board-data';
import { Avatar, Spinner } from '../ui';

function sentence(item: ActivityDto, members: Map<string, string>): string {
  const text = describeActivity(item.type as ActivityType, item.data);
  // Assignment entries store a user id; show the name when we know it.
  if ((item.type === 'card.assigned' || item.type === 'card.unassigned') && item.data.userId) {
    const name = members.get(item.data.userId) ?? 'someone';
    return text.replace('someone', name);
  }
  return text;
}

export function ActivityList({
  boardId,
  cardId,
  members,
  onOpenCard,
}: {
  boardId: string;
  cardId?: string;
  members: Map<string, string>;
  onOpenCard?: (cardId: string) => void;
}) {
  const feed = useActivityFeed(boardId, cardId);
  if (feed.isPending) return <Spinner />;
  if (feed.error) return <p className="text-xs text-rose-600">Could not load activity.</p>;
  const items = feed.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <p className="text-xs text-slate-400">No activity yet.</p>;
  return (
    <div>
      <ol className="space-y-2.5" data-testid="activity-list">
        {items.map((item) => (
          <li key={item.id} className="flex gap-2 text-xs leading-snug">
            {item.actor ? (
              <Avatar id={item.actor.id} name={item.actor.name} size={20} />
            ) : (
              <span className="size-5" />
            )}
            <div className="min-w-0">
              <span className="font-medium text-slate-800">{item.actor?.name ?? 'Someone'}</span>{' '}
              {onOpenCard && item.cardId && item.type !== 'card.deleted' ? (
                <button
                  className="text-left text-slate-600 hover:text-indigo-700 hover:underline"
                  onClick={() => onOpenCard(item.cardId!)}
                >
                  {sentence(item, members)}
                </button>
              ) : (
                <span className="text-slate-600">{sentence(item, members)}</span>
              )}
              <div className="text-[10px] text-slate-400">{timeAgo(item.createdAt)}</div>
            </div>
          </li>
        ))}
      </ol>
      {feed.hasNextPage ? (
        <button
          className="mt-3 text-xs text-indigo-600 hover:underline"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetchingNextPage}
        >
          {feed.isFetchingNextPage ? 'Loading…' : 'Load older activity'}
        </button>
      ) : null}
    </div>
  );
}
