import type { ConnectionState } from '../../lib/collab';

/**
 * Always-visible connection indicator. Being honest about sync state matters
 * more in a local-first app than in a request/response one: edits never fail,
 * so this is the only place a user learns they are not reaching anyone.
 */
export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const { phase, unsyncedChanges, attempt, synced } = state;
  let dot = 'bg-emerald-500';
  let label = 'Live';
  let detail = 'All changes synced';

  if (phase === 'offline') {
    dot = 'bg-slate-400';
    label = 'Offline';
    detail = 'Edits are saved on this device and will sync when you reconnect';
  } else if (phase === 'reconnecting') {
    dot = 'bg-amber-500 animate-pulse';
    label = 'Reconnecting';
    detail = `Retrying with backoff (attempt ${Math.max(attempt, 1)}). Edits are saved locally.`;
  } else if (phase === 'connecting' || !synced) {
    dot = 'bg-sky-500 animate-pulse';
    label = 'Connecting';
    detail = 'Loading the latest board';
  } else if (unsyncedChanges > 0) {
    dot = 'bg-sky-500';
    label = 'Saving';
    detail = `${unsyncedChanges} change${unsyncedChanges === 1 ? '' : 's'} waiting for the server`;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      title={detail}
      data-testid="connection-status"
      data-phase={phase}
      className="flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200"
    >
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
      {(phase === 'offline' || phase === 'reconnecting') && unsyncedChanges > 0 ? (
        <span className="text-slate-400">· {unsyncedChanges} pending</span>
      ) : null}
    </div>
  );
}
