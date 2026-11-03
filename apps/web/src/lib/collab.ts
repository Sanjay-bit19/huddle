import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from '@hocuspocus/provider';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
  boardDocumentName,
  boardStatelessSchema,
  COLLAB_REASONS,
  type BoardStateless,
  type Role,
} from '@huddle/shared';
import { readBoard, type BoardView } from '@huddle/shared/board';
import { getAccessToken, onLoggedOut, refreshSession, setSession } from './api';

export function collabUrl(): string {
  const configured = import.meta.env.VITE_COLLAB_URL as string | undefined;
  if (configured) return configured;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/collab`;
}

export type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Initial sync with the server done at least once this session. */
  synced: boolean;
  /** Local updates the server has not acknowledged yet. */
  unsyncedChanges: number;
  /** Consecutive failed connection attempts (drives the reconnect banner). */
  attempt: number;
  /** Local copy restored from IndexedDB (lets the board render offline). */
  restoredLocally: boolean;
  /** Access established by the server for this socket. */
  readOnly: boolean | null;
  /** Fatal: the user cannot (or can no longer) access the board. */
  fatal: string | null;
}

const initialState: ConnectionState = {
  phase: 'connecting',
  synced: false,
  unsyncedChanges: 0,
  attempt: 0,
  restoredLocally: false,
  readOnly: null,
  fatal: null,
};

export interface BoardConnection {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  state: ConnectionState;
  /** Latest role pushed by the server (live role changes). */
  liveRole: Role | null;
  onStateless: (listener: (msg: BoardStateless) => void) => () => void;
}

/** IndexedDB database name: per user so two accounts on one browser never mix. */
export const offlineDbName = (boardId: string, userId: string) => `huddle:${userId}:${boardId}`;

/** Wipes every locally cached board (on logout). */
export async function clearOfflineData(): Promise<void> {
  if (!('databases' in indexedDB)) return;
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs
      .filter((d) => d.name?.startsWith('huddle:'))
      .map(
        (d) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(d.name!);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
  );
}

// Locally cached boards are private data: drop them when the session ends.
onLoggedOut(clearOfflineData);

/**
 * Owns one board's Y.Doc for the lifetime of the page:
 *   IndexedDB (offline cache)  <->  Y.Doc  <->  HocuspocusProvider (WebSocket)
 *
 * Edits always go to the local doc first. While disconnected they accumulate
 * in IndexedDB; on reconnect the provider runs the Yjs sync handshake
 * (exchange state vectors, send what the other side lacks) and the CRDT
 * merges them with whatever happened on the server meanwhile.
 */
export function useBoardConnection(boardId: string, userId: string): BoardConnection | null {
  const [state, setState] = useState<ConnectionState>(initialState);
  const [liveRole, setLiveRole] = useState<Role | null>(null);
  const [resources, setResources] = useState<{
    doc: Y.Doc;
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
  } | null>(null);
  const statelessListeners = useRef(new Set<(msg: BoardStateless) => void>());

  // Resources are created inside the effect (not useMemo) so that every mount
  // owns, and its cleanup destroys, exactly what it created. React StrictMode
  // mounts twice in development and would otherwise reuse destroyed objects.
  useEffect(() => {
    setState(initialState);
    setLiveRole(null);
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(offlineDbName(boardId, userId), doc);
    let authRetries = 0;
    let disposed = false;
    const socket = new HocuspocusProviderWebsocket({
      url: collabUrl(),
      // Exponential backoff with jitter: ~1s, 2s, 4s ... capped at 30s, forever.
      delay: 1000,
      factor: 2,
      minDelay: 1000,
      maxDelay: 30_000,
      jitter: true,
      maxAttempts: 0,
    });
    const update = (fn: (s: ConnectionState) => ConnectionState) => {
      if (!disposed) setState(fn);
    };
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: boardDocumentName(boardId),
      document: doc,
      // Called on every (re)connect, so a reconnect after expiry uses a fresh token.
      token: async () => (await getAccessToken()) ?? '',
      onStatus: ({ status }) => {
        update((s) => {
          if (status === WebSocketStatus.Connected) return { ...s, phase: 'connected', attempt: 0 };
          if (status === WebSocketStatus.Connecting) {
            return {
              ...s,
              phase: !navigator.onLine ? 'offline' : s.synced ? 'reconnecting' : 'connecting',
              attempt: s.attempt + 1,
            };
          }
          return { ...s, phase: navigator.onLine ? 'reconnecting' : 'offline' };
        });
      },
      onSynced: ({ state: isSynced }) => {
        if (isSynced) update((s) => ({ ...s, synced: true }));
      },
      onAuthenticated: ({ scope }) => {
        authRetries = 0;
        update((s) => ({ ...s, readOnly: scope === 'readonly', fatal: null }));
      },
      onAuthenticationFailed: ({ reason }) => {
        void handleAuthFailure(reason);
      },
      onUnsyncedChanges: ({ number }) => update((s) => ({ ...s, unsyncedChanges: number })),
      onStateless: ({ payload }) => {
        let msg: BoardStateless;
        try {
          msg = boardStatelessSchema.parse(JSON.parse(payload));
        } catch {
          return;
        }
        if (msg.kind === 'role-changed') {
          setLiveRole(msg.role);
          update((s) => ({ ...s, readOnly: msg.role === 'VIEWER' }));
        }
        statelessListeners.current.forEach((l) => l(msg));
      },
      onClose: ({ event }) => {
        const reason = String(event?.reason ?? '');
        if (reason === COLLAB_REASONS.sessionRevoked) setSession(null);
        else if (
          reason === COLLAB_REASONS.accessRevoked ||
          reason === COLLAB_REASONS.boardDeleted ||
          reason === COLLAB_REASONS.forbidden
        ) {
          update((s) => ({ ...s, fatal: reason }));
          socket.disconnect();
        }
      },
    });
    provider.attach();

    async function handleAuthFailure(reason: string) {
      if (reason === COLLAB_REASONS.sessionRevoked) {
        setSession(null);
        return;
      }
      if (reason === COLLAB_REASONS.unauthorized && authRetries < 3) {
        // Expired or rotated token: refresh and re-handshake.
        authRetries += 1;
        if (await refreshSession()) {
          socket.disconnect();
          await socket.connect();
          return;
        }
      }
      update((s) => ({ ...s, fatal: reason }));
      socket.disconnect();
    }

    persistence.once('synced', () => update((s) => ({ ...s, restoredLocally: true })));
    // Browsers report connectivity changes long before a ping would time out.
    const goOffline = () => {
      update((s) => ({ ...s, phase: 'offline' }));
      socket.disconnect();
    };
    const goOnline = () => {
      update((s) => ({ ...s, phase: 'reconnecting', attempt: 0 }));
      void socket.connect();
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    setResources({ doc, provider, socket });

    return () => {
      disposed = true;
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      provider.destroy();
      socket.destroy();
      void persistence.destroy();
      doc.destroy();
      setResources(null);
    };
  }, [boardId, userId]);

  const onStateless = useCallback((listener: (msg: BoardStateless) => void) => {
    statelessListeners.current.add(listener);
    return () => {
      statelessListeners.current.delete(listener);
    };
  }, []);

  return useMemo(
    () => (resources ? { ...resources, state, liveRole, onStateless } : null),
    [resources, state, liveRole, onStateless],
  );
}

/**
 * Plain-object view of the board, recomputed at most once per animation frame
 * however many Yjs updates arrive (typing produces one per keystroke).
 */
export function useBoardView(doc: Y.Doc): BoardView {
  const store = useMemo(() => {
    let view = readBoard(doc);
    let frame = 0;
    const listeners = new Set<() => void>();
    const onUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        view = readBoard(doc);
        listeners.forEach((l) => l());
      });
    };
    return {
      subscribe(listener: () => void) {
        if (listeners.size === 0) doc.on('update', onUpdate);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            doc.off('update', onUpdate);
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
          }
        };
      },
      getSnapshot: () => view,
    };
  }, [doc]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
