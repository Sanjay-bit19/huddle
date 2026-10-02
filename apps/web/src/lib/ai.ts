import { useQuery } from '@tanstack/react-query';
import {
  aiStreamEventSchema,
  type AiStatus,
  type AiStreamEvent,
  type NotesToCardsResponse,
} from '@huddle/shared';
import { api, apiResponse } from './api';

export const aiStatusKey = ['ai', 'status'] as const;

export function useAiStatus() {
  return useQuery({ queryKey: aiStatusKey, queryFn: () => api<AiStatus>('/api/ai/status') });
}

export function notesToCards(boardId: string, notes: string, signal?: AbortSignal) {
  return api<NotesToCardsResponse>(`/api/boards/${boardId}/ai/notes-to-cards`, {
    body: { notes },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Reads a Server-Sent Events response from a POST. EventSource cannot send a
 * body or an Authorization header, so we parse the stream ourselves.
 */
export async function streamAi(
  path: string,
  body: unknown,
  onEvent: (e: AiStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await apiResponse(path, { body, signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue; // comments / keep-alives
      const parsed = aiStreamEventSchema.safeParse({ event, data: JSON.parse(data) });
      if (!parsed.success) throw new Error(`Unexpected AI stream event "${event}"`);
      onEvent(parsed.data);
    }
  }
}
