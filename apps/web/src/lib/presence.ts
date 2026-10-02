import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useMemo, useState } from 'react';
import { awarenessStateSchema, type AwarenessState, type PresenceUser } from '@huddle/shared';

export interface Peer {
  clientId: number;
  user: PresenceUser;
  pointer: { x: number; y: number } | null;
  editingCardId: string | null;
  draggingCardId: string | null;
}

/**
 * Presence rides on Yjs awareness: ephemeral per-client state that is
 * broadcast but never persisted. The server re-stamps `user` from the verified
 * token, so what we set here for ourselves is only a hint.
 */
export function usePresence(provider: HocuspocusProvider, me: PresenceUser) {
  const awareness = provider.awareness!;
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    awareness.setLocalStateField('user', me);
    const read = () => {
      const list: Peer[] = [];
      awareness.getStates().forEach((raw, clientId) => {
        if (clientId === awareness.clientID) return;
        const parsed = awarenessStateSchema.safeParse(raw);
        if (!parsed.success) return;
        const s: AwarenessState = parsed.data;
        list.push({
          clientId,
          user: s.user,
          pointer: s.pointer ?? null,
          editingCardId: s.editingCardId ?? null,
          draggingCardId: s.draggingCardId ?? null,
        });
      });
      setPeers(list);
    };
    read();
    awareness.on('change', read);
    return () => {
      awareness.off('change', read);
    };
  }, [awareness, me]);

  const api = useMemo(
    () => ({
      setEditingCard: (cardId: string | null) =>
        awareness.setLocalStateField('editingCardId', cardId),
      setDraggingCard: (cardId: string | null) =>
        awareness.setLocalStateField('draggingCardId', cardId),
      setPointer: (pointer: { x: number; y: number } | null) =>
        awareness.setLocalStateField('pointer', pointer),
    }),
    [awareness],
  );

  return { peers, ...api };
}

/** One entry per person (a user with two tabs open shows once). */
export function uniqueUsers(peers: Peer[], me?: PresenceUser): PresenceUser[] {
  const seen = new Map<string, PresenceUser>();
  if (me) seen.set(me.id, me);
  for (const p of peers) if (!seen.has(p.user.id)) seen.set(p.user.id, p.user);
  return [...seen.values()];
}

export function groupByCard(
  peers: Peer[],
  field: 'editingCardId' | 'draggingCardId',
  selfId: string,
) {
  const map = new Map<string, PresenceUser[]>();
  for (const p of peers) {
    const cardId = p[field];
    if (!cardId || p.user.id === selfId) continue;
    const list = map.get(cardId) ?? [];
    if (!list.some((u) => u.id === p.user.id)) list.push(p.user);
    map.set(cardId, list);
  }
  return map;
}

/** Calls `fn` at most once per `ms`, always delivering the latest value. */
export function throttle<T>(fn: (v: T) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T;
  return (value: T) => {
    pending = value;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(value);
    } else if (!timer) {
      timer = setTimeout(
        () => {
          timer = null;
          last = Date.now();
          fn(pending);
        },
        ms - (now - last),
      );
    }
  };
}
