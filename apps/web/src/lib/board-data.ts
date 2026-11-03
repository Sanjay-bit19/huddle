import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface ActivityDto {
  id: number;
  type: string;
  cardId: string | null;
  data: Record<string, string | null>;
  actor: { id: string; name: string } | null;
  createdAt: string;
}

export interface CommentDto {
  id: string;
  cardId: string;
  body: string;
  author: { id: string; name: string } | null;
  createdAt: string;
}

export interface SearchHit {
  boardId: string;
  boardTitle: string;
  cardId: string;
  title: string;
  columnTitle: string;
  snippet: string;
}

export const boardDataKeys = {
  activity: (boardId: string, cardId?: string) => ['activity', boardId, cardId ?? null] as const,
  activityAll: (boardId: string) => ['activity', boardId] as const,
  comments: (boardId: string, cardId: string) => ['comments', boardId, cardId] as const,
};

export function useActivityFeed(boardId: string, cardId?: string) {
  return useInfiniteQuery({
    queryKey: boardDataKeys.activity(boardId, cardId),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: cardId ? '20' : '40' });
      if (cardId) params.set('cardId', cardId);
      if (pageParam) params.set('before', String(pageParam));
      return api<{ items: ActivityDto[]; nextBefore: number | null }>(
        `/api/boards/${boardId}/activity?${params}`,
      );
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useComments(boardId: string, cardId: string) {
  return useQuery({
    queryKey: boardDataKeys.comments(boardId, cardId),
    queryFn: () =>
      api<{ comments: CommentDto[] }>(
        `/api/boards/${boardId}/cards/${encodeURIComponent(cardId)}/comments`,
      ),
    select: (d) => d.comments,
  });
}

export function useAddComment(boardId: string, cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api(`/api/boards/${boardId}/cards/${encodeURIComponent(cardId)}/comments`, {
        body: { body },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardDataKeys.comments(boardId, cardId) }),
  });
}

export function useDeleteComment(boardId: string, cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      api(`/api/boards/${boardId}/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardDataKeys.comments(boardId, cardId) }),
  });
}

export function useSearch(workspaceId: string, q: string) {
  return useQuery({
    queryKey: ['search', workspaceId, q],
    queryFn: ({ signal }) =>
      api<{ hits: SearchHit[] }>(
        `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`,
        {
          signal,
        },
      ),
    select: (d) => d.hits,
    enabled: q.trim().length > 0,
    staleTime: 5_000,
  });
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}
