import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notesToCardsJsonSchema } from '@huddle/shared';
import { AnthropicProvider } from './anthropic';
import { LlmRefusalError, LlmUnavailableError, type LlmStreamEvent } from './types';

/**
 * Contract test against a local fake of the Messages API: verifies the exact
 * request the provider sends and how it maps responses, without a network or
 * API key.
 */
interface Captured {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let baseURL: string;
let captured: Captured[] = [];
let respond: (body: Record<string, unknown>) => { status?: number; json?: unknown; sse?: string[] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      captured.push({ headers: req.headers, body });
      const out = respond(body);
      if (out.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of out.sse) res.write(e);
        res.end();
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  captured = [];
});

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: '{"cards": []}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 0,
  },
  ...over,
});

const provider = (fallbacks = true) =>
  new AnthropicProvider('claude-opus-5-5', {
    timeoutMs: 5000,
    fallbacks,
    apiKey: 'test-key',
    baseURL,
  });

const req = () => ({
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'notes' }],
  maxTokens: 8000,
  effort: 'medium' as const,
  signal: new AbortController().signal,
});

describe('AnthropicProvider.completeJson', () => {
  it('sends structured output, explicit effort and the default refusal fallback', async () => {
    respond = () => ({ json: message() });
    const result = await provider().completeJson({
      ...req(),
      jsonSchema: notesToCardsJsonSchema as unknown as Record<string, unknown>,
    });
    const { body, headers } = captured[0]!;
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      system: 'sys',
      messages: [{ role: 'user', content: 'notes' }],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: notesToCardsJsonSchema },
      },
    });
    // No forced tool_choice (rejected by current models) and no thinking override.
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('thinking');
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(headers['x-api-key']).toBe('test-key');
    expect(result).toEqual({
      text: '{"cards": []}',
      usage: { inputTokens: 130, outputTokens: 30 },
      model: 'claude-opus-5-5',
      stopReason: 'end_turn',
    });
  });

  it('omits the fallback parameter and beta header when disabled', async () => {
    respond = () => ({ json: message() });
    await provider(false).completeJson({ ...req(), jsonSchema: {} });
    expect(captured[0]!.body).not.toHaveProperty('fallbacks');
    expect(captured[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('reports the model that actually answered after a fallback', async () => {
    respond = () => ({ json: message({ model: 'claude-opus-4-8' }) });
    const result = await provider().completeJson({ ...req(), jsonSchema: {} });
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('throws a refusal before reading content', async () => {
    respond = () => ({ json: message({ stop_reason: 'refusal', content: [] }) });
    await expect(provider().completeJson({ ...req(), jsonSchema: {} })).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
  });

  it('maps API errors to LlmUnavailableError', async () => {
    respond = () => ({
      status: 529,
      json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    await expect(provider().completeJson({ ...req(), jsonSchema: {} })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    // One SDK retry before giving up.
    expect(captured).toHaveLength(2);
  });
});

describe('AnthropicProvider.streamText', () => {
  const sse = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const stream = (stopReason: string) => [
    sse('message_start', {
      type: 'message_start',
      message: message({ content: [], usage: { input_tokens: 200, output_tokens: 1 } }),
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello ' },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'world [C1]' },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 42 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ];

  it('yields text deltas then final usage', async () => {
    respond = () => ({ sse: stream('end_turn') });
    const events: LlmStreamEvent[] = [];
    for await (const e of provider().streamText({ ...req(), effort: 'low' })) events.push(e);
    expect(captured[0]!.body).toMatchObject({
      stream: true,
      output_config: { effort: 'low' },
      fallbacks: 'default',
    });
    expect(events).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world [C1]' },
      {
        type: 'end',
        usage: { inputTokens: 200, outputTokens: 42 },
        model: 'claude-opus-5-5',
        stopReason: 'end_turn',
      },
    ]);
  });

  it('reports a mid-stream refusal as a stop reason, not an exception', async () => {
    respond = () => ({ sse: stream('refusal') });
    const events: LlmStreamEvent[] = [];
    for await (const e of provider().streamText(req())) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'end', stopReason: 'refusal' });
  });
});
