import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { can, userColor, type PresenceUser } from '@huddle/shared';
import { AppHeader } from '../components/Layout';
import { SearchBox } from '../components/SearchBox';
import { ActivityList } from '../components/board/ActivityList';
import { AiPanel } from '../components/board/AiPanel';
import { Comments } from '../components/board/Comments';
import { BoardCanvas } from '../components/board/BoardCanvas';
import { CardDetail } from '../components/board/CardDetail';
import { ConnectionStatus } from '../components/board/ConnectionStatus';
import { LiveCursors, PresenceAvatars } from '../components/board/Presence';
import { ErrorBanner, Spinner } from '../components/ui';
import { useCurrentUser } from '../lib/auth';
import {
  useBoardConnection,
  useBoardView,
  type BoardConnection,
  type ConnectionState,
} from '../lib/collab';
import { groupByCard, throttle, uniqueUsers, usePresence } from '../lib/presence';
import { boardDataKeys } from '../lib/board-data';
import { qk, useBoard, useMembers, type BoardDetails } from '../lib/queries';
import { RoleBadge } from './HomePage';

export function BoardPage() {
  const { boardId = '' } = useParams();
  const board = useBoard(boardId);

  if (board.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Opening board" />
      </div>
    );
  }
  if (board.error) {
    return (
      <div className="min-h-full">
        <AppHeader />
        <div className="mx-auto max-w-xl p-10">
          <ErrorBanner error={board.error} />
        </div>
      </div>
    );
  }
  return <BoardScreen key={boardId} details={board.data} />;
}

const FATAL_MESSAGES: Record<string, string> = {
  'access-revoked': 'Your access to this board was removed.',
  'board-deleted': 'This board was deleted.',
  forbidden: 'You do not have access to this board.',
  unauthorized: 'Your session expired. Sign in again.',
};

function BoardScreen({ details }: { details: BoardDetails }) {
  const user = useCurrentUser();
  const connection = useBoardConnection(details.board.id, user.id);
  if (!connection) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Opening board" />
      </div>
    );
  }
  return <ConnectedBoard details={details} connection={connection} />;
}

function ConnectedBoard({
  details,
  connection,
}: {
  details: BoardDetails;
  connection: BoardConnection;
}) {
  const user = useCurrentUser();
  const qc = useQueryClient();
  const { doc, provider, state, onStateless } = connection;
  const view = useBoardView(doc);
  const members = useMembers(details.workspace.id);
  // The open card lives in the URL (?card=) so search results and shared links deep-link to it.
  const [searchParams, setSearchParams] = useSearchParams();
  const openCardId = searchParams.get('card');
  const setOpenCardId = useCallback(
    (id: string | null) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('card', id);
          else next.delete('card');
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const [sidePanel, setSidePanel] = useState<'ai' | 'activity' | null>(null);

  const role = connection.liveRole ?? details.role;
  // The socket's scope is authoritative; until it arrives fall back to the role.
  const readOnly = state.readOnly ?? !can(role, 'board:write');
  const me: PresenceUser = useMemo(
    () => ({ id: user.id, name: user.name, color: userColor(user.id) }),
    [user.id, user.name],
  );

  const memberNames = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.userId, m.name])),
    [members.data],
  );

  const presence = usePresence(provider, me);
  const { setEditingCard, setDraggingCard, setPointer } = presence;
  const onPointer = useMemo(() => throttle(setPointer, 40), [setPointer]);
  const editorsByCard = useMemo(
    () => groupByCard(presence.peers, 'editingCardId', user.id),
    [presence.peers, user.id],
  );
  const moversByCard = useMemo(
    () => groupByCard(presence.peers, 'draggingCardId', user.id),
    [presence.peers, user.id],
  );
  const onlineUsers = useMemo(() => uniqueUsers(presence.peers, me), [presence.peers, me]);

  const boardId = details.board.id;
  useEffect(
    () =>
      onStateless((msg) => {
        if (msg.kind === 'board-meta-changed' || msg.kind === 'role-changed') {
          void qc.invalidateQueries({ queryKey: qk.board(boardId) });
        } else if (msg.kind === 'comments-changed') {
          void qc.invalidateQueries({ queryKey: boardDataKeys.comments(boardId, msg.cardId) });
        } else if (msg.kind === 'activity') {
          void qc.invalidateQueries({ queryKey: boardDataKeys.activityAll(boardId) });
        }
      }),
    [onStateless, qc, boardId],
  );

  const openCard = openCardId ? view.cards.find((c) => c.id === openCardId) : undefined;
  // Close the panel if the open card disappears (deleted, possibly by someone
  // else). Only for a card we have actually shown: a deep link (?card=) may
  // briefly point at a card the first render of the view does not have yet.
  const shownCardRef = useRef<string | null>(null);
  if (openCard) shownCardRef.current = openCard.id;
  useEffect(() => {
    if (openCardId && !openCard && shownCardRef.current === openCardId) {
      shownCardRef.current = null;
      setOpenCardId(null);
    }
  }, [openCardId, openCard, setOpenCardId]);
  useEffect(() => {
    // Viewers only look; tell others "X is editing" just for writers.
    setEditingCard(openCardId && !readOnly ? openCardId : null);
  }, [openCardId, readOnly, setEditingCard]);

  if (state.fatal) {
    return (
      <div className="min-h-full">
        <AppHeader />
        <div className="mx-auto max-w-md p-10 text-center">
          <h1 className="text-lg font-semibold">
            {FATAL_MESSAGES[state.fatal] ?? 'Disconnected from this board.'}
          </h1>
          <Link
            to={`/w/${details.workspace.id}`}
            className="mt-4 inline-block text-sm text-indigo-600 hover:underline"
          >
            Back to {details.workspace.name}
          </Link>
        </div>
      </div>
    );
  }

  const ready = state.synced || state.restoredLocally;

  return (
    <div className="flex h-full flex-col">
      <AppHeader>
        <span className="text-slate-300">/</span>
        <Link
          to={`/w/${details.workspace.id}`}
          className="truncate text-slate-500 hover:text-slate-700"
        >
          {details.workspace.name}
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="truncate font-semibold" data-testid="board-title">
          {details.board.title}
        </h1>
        <RoleBadge role={role} />
        {readOnly ? <span className="text-xs text-slate-500">View only</span> : null}
        <div className="ml-auto flex items-center gap-3">
          <SearchBox workspaceId={details.workspace.id} />
          <PresenceAvatars users={onlineUsers} />
          <ConnectionStatus state={state} />
          <button
            onClick={() => setSidePanel((p) => (p === 'activity' ? null : 'activity'))}
            aria-pressed={sidePanel === 'activity'}
            className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 transition ${
              sidePanel === 'activity'
                ? 'bg-slate-800 text-white ring-slate-800'
                : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            Activity
          </button>
          <button
            onClick={() => setSidePanel((p) => (p === 'ai' ? null : 'ai'))}
            aria-pressed={sidePanel === 'ai'}
            className={`rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap ring-1 transition ${
              sidePanel === 'ai'
                ? 'bg-indigo-600 text-white ring-indigo-600'
                : 'bg-white text-indigo-700 ring-indigo-200 hover:bg-indigo-50'
            }`}
          >
            ✨ AI assist
          </button>
        </div>
      </AppHeader>
      <OfflineBanner state={state} />

      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1">
          {!ready ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Syncing board" />
            </div>
          ) : (
            <BoardCanvas
              doc={doc}
              view={view}
              readOnly={readOnly}
              userId={user.id}
              members={memberNames}
              editorsByCard={editorsByCard}
              moversByCard={moversByCard}
              onOpenCard={setOpenCardId}
              onDragCard={setDraggingCard}
              onPointer={onPointer}
              overlay={<LiveCursors peers={presence.peers} />}
            />
          )}
        </main>
        {sidePanel === 'activity' ? (
          <aside
            className="flex h-full w-[360px] shrink-0 flex-col border-l border-slate-200 bg-white"
            aria-label="Board activity"
          >
            <header className="flex items-center border-b border-slate-100 px-4 py-3">
              <h2 className="font-semibold">Activity</h2>
              <button
                onClick={() => setSidePanel(null)}
                className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100"
                aria-label="Close activity"
              >
                ✕
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ActivityList
                boardId={details.board.id}
                members={memberNames}
                onOpenCard={setOpenCardId}
              />
            </div>
          </aside>
        ) : null}
        {sidePanel === 'ai' ? (
          <AiPanel
            boardId={details.board.id}
            doc={doc}
            columns={view.columns}
            userId={user.id}
            canWrite={!readOnly && can(role, 'ai:write')}
            onOpenCard={setOpenCardId}
            onClose={() => setSidePanel(null)}
          />
        ) : null}
      </div>

      {openCard ? (
        <CardDetail
          doc={doc}
          provider={provider}
          card={openCard}
          columnTitle={view.columns.find((c) => c.id === openCard.columnId)?.title ?? ''}
          readOnly={readOnly}
          me={me}
          members={members.data ?? []}
          otherEditors={editorsByCard.get(openCard.id) ?? []}
          onClose={() => setOpenCardId(null)}
          footer={
            <>
              <Comments
                boardId={details.board.id}
                cardId={openCard.id}
                role={role}
                userId={user.id}
              />
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  History
                </h3>
                <ActivityList
                  boardId={details.board.id}
                  cardId={openCard.id}
                  members={memberNames}
                />
              </section>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function OfflineBanner({ state }: { state: ConnectionState }) {
  if (!state.synced && state.phase !== 'offline') return null;
  if (state.phase !== 'offline' && state.phase !== 'reconnecting') return null;
  return (
    <div
      role="alert"
      data-testid="offline-banner"
      className={`px-4 py-1.5 text-center text-xs font-medium ${
        state.phase === 'offline' ? 'bg-slate-700 text-white' : 'bg-amber-100 text-amber-900'
      }`}
    >
      {state.phase === 'offline'
        ? "You're offline. Keep working: changes are saved on this device and merge automatically when you reconnect."
        : `Connection lost. Reconnecting with backoff (attempt ${Math.max(state.attempt, 1)})… your edits are safe.`}
      {state.unsyncedChanges > 0 ? ` ${state.unsyncedChanges} change(s) pending.` : ''}
    </div>
  );
}
