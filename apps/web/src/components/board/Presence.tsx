import type { PresenceUser } from '@huddle/shared';
import type { Peer } from '../../lib/presence';
import { Avatar } from '../ui';

export function PresenceAvatars({ users, max = 5 }: { users: PresenceUser[]; max?: number }) {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <div
      className="flex items-center"
      aria-label={`${users.length} people on this board`}
      data-testid="presence"
    >
      <div className="flex -space-x-2">
        {shown.map((u) => (
          <span
            key={u.id}
            className="relative"
            data-testid="presence-avatar"
            data-user-name={u.name}
          >
            <Avatar id={u.id} name={u.name} size={28} ring />
            <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
          </span>
        ))}
      </div>
      {extra > 0 ? (
        <span className="ml-1.5 text-xs font-medium text-slate-500">+{extra}</span>
      ) : null}
    </div>
  );
}

/**
 * Remote mouse pointers, positioned in board-content coordinates so they line
 * up regardless of each person's scroll position or window size.
 */
export function LiveCursors({ peers }: { peers: Peer[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-visible" aria-hidden="true">
      {peers
        .filter((p) => p.pointer)
        .map((p) => (
          <div
            key={p.clientId}
            className="absolute top-0 left-0 transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${p.pointer!.x}px, ${p.pointer!.y}px)` }}
            data-testid="live-cursor"
            data-user-name={p.user.name}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" style={{ color: p.user.color }}>
              <path
                d="M2 2 L16 8 L9 10 L7 16 Z"
                fill="currentColor"
                stroke="white"
                strokeWidth="1.5"
              />
            </svg>
            <span
              className="ml-3 rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white shadow"
              style={{ background: p.user.color }}
            >
              {p.user.name}
            </span>
          </div>
        ))}
    </div>
  );
}
