import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardDto, InviteDto, MemberDto, Role, WorkspaceSummary } from '@huddle/shared';
import { api } from './api';

export const qk = {
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  members: (id: string) => ['workspace', id, 'members'] as const,
  invites: (id: string) => ['workspace', id, 'invites'] as const,
  boards: (id: string) => ['workspace', id, 'boards'] as const,
  board: (id: string) => ['board', id] as const,
};

export function useWorkspaces() {
  return useQuery({
    queryKey: qk.workspaces,
    queryFn: () => api<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
    select: (d) => d.workspaces,
  });
}

export function useWorkspace(id: string) {
  return useQuery({
    queryKey: qk.workspace(id),
    queryFn: () =>
      api<{ workspace: { id: string; name: string; role: Role } }>(`/api/workspaces/${id}`),
    select: (d) => d.workspace,
  });
}

export function useMembers(id: string) {
  return useQuery({
    queryKey: qk.members(id),
    queryFn: () => api<{ members: MemberDto[] }>(`/api/workspaces/${id}/members`),
    select: (d) => d.members,
  });
}

export function useInvites(id: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.invites(id),
    queryFn: () => api<{ invites: InviteDto[] }>(`/api/workspaces/${id}/invites`),
    select: (d) => d.invites,
    enabled,
  });
}

export function useBoards(workspaceId: string) {
  return useQuery({
    queryKey: qk.boards(workspaceId),
    queryFn: () => api<{ boards: BoardDto[] }>(`/api/workspaces/${workspaceId}/boards`),
    select: (d) => d.boards,
  });
}

export interface BoardDetails {
  board: BoardDto;
  workspace: { id: string; name: string };
  role: Role;
}

export function useBoard(boardId: string) {
  return useQuery({
    queryKey: qk.board(boardId),
    queryFn: () => api<BoardDetails>(`/api/boards/${boardId}`),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<{ workspace: { id: string } }>('/api/workspaces', { body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workspaces }),
  });
}

export function useCreateBoard(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; description?: string }) =>
      api<{ board: BoardDto }>(`/api/workspaces/${workspaceId}/boards`, { body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.boards(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
  });
}

export function useUpdateBoard(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string; description?: string }) =>
      api<{ board: BoardDto }>(`/api/boards/${boardId}`, { method: 'PATCH', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.board(boardId) }),
  });
}

export function useDeleteBoard(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (boardId: string) => api(`/api/boards/${boardId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards(workspaceId) }),
  });
}

export function useUpdateMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(workspaceId) }),
  });
}

export function useRemoveMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.members(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
  });
}

export function useCreateInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { role: Role; expiresInHours: number; maxUses: number | null }) =>
      api<{ token: string; url: string }>(`/api/workspaces/${workspaceId}/invites`, {
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invites(workspaceId) }),
  });
}

export function useRevokeInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api(`/api/workspaces/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invites(workspaceId) }),
  });
}
