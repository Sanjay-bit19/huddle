import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { can, userColor, type PresenceUser } from '@huddle/shared';
import { AppHeader } from '../components/Layout';
import { BoardCanvas } from '../components/board/BoardCanvas';
import { CardDetail } from '../components/board/CardDetail';
import { ConnectionStatus } from '../components/board/ConnectionStatus';
import { ErrorBanner, Spinner } from '../components/ui';
import { useCurrentUser } from '../lib/auth';
import { useBoardConnection, useBoardView, type BoardConnection } from '../lib/collab';
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
  const [openCardId, setOpenCardId] = useState<string | null>(null);

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

  const boardId = details.board.id;
  useEffect(
    () =>
      onStateless((msg) => {
        if (msg.kind === 'board-meta-changed' || msg.kind === 'role-changed') {
          void qc.invalidateQueries({ queryKey: qk.board(boardId) });
        }
      }),
    [onStateless, qc, boardId],
  );

  const openCard = openCardId ? view.cards.find((c) => c.id === openCardId) : undefined;
  useEffect(() => {
    // Close the panel if the card was deleted (possibly by someone else).
    if (openCardId && !openCard && state.synced) setOpenCardId(null);
  }, [openCardId, openCard, state.synced]);

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
          <ConnectionStatus state={state} />
        </div>
      </AppHeader>

      <main className="min-h-0 flex-1">
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
            editorsByCard={new Map()}
            onOpenCard={setOpenCardId}
          />
        )}
      </main>

      {openCard ? (
        <CardDetail
          doc={doc}
          provider={provider}
          card={openCard}
          columnTitle={view.columns.find((c) => c.id === openCard.columnId)?.title ?? ''}
          readOnly={readOnly}
          me={me}
          members={members.data ?? []}
          otherEditors={[]}
          onClose={() => setOpenCardId(null)}
        />
      ) : null}
    </div>
  );
}
