import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  LlmRefusalError,
  LlmUnavailableError,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmStreamEvent,
  type LlmUsage,
} from './types';

/**
 * Claude via the official SDK. Notes:
 * - Structured outputs (`output_config.format`) constrain the JSON shape;
 *   forced tool_choice is not used (current models reject it).
 * - Thinking is left at the model default (adaptive) and effort is set
 *   explicitly per feature, since the default differs between models.
 * - `fallbacks: "default"` re-runs a request that a safety classifier
 *   declines on Anthropic's recommended fallback model, server-side, inside
 *   the same call. A request that is still declined surfaces as a refusal.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    private readonly opts: {
      timeoutMs: number;
      fallbacks: boolean;
      apiKey?: string | undefined;
      baseURL?: string | undefined;
    },
  ) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      // One SDK-level retry for 429/5xx/connection errors; our own retry loop
      // is reserved for invalid model output.
      maxRetries: 1,
      timeout: opts.timeoutMs,
    });
  }

  private baseParams(req: LlmRequest) {
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      ...(this.opts.fallbacks
        ? { fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] }
        : {}),
    };
  }

  async completeJson(req: LlmJsonRequest): Promise<LlmResult> {
    const params: MessageCreateParamsNonStreaming = {
      ...this.baseParams(req),
      output_config: {
        effort: req.effort,
        format: { type: 'json_schema', schema: req.jsonSchema },
      },
    };
    let message: BetaMessage;
    try {
      message = await this.client.beta.messages.create(params, { signal: req.signal });
    } catch (err) {
      throw toProviderError(err);
    }
    return toResult(message);
  }

  async *streamText(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const stream = this.client.beta.messages.stream(
      { ...this.baseParams(req), output_config: { effort: req.effort } },
      { signal: req.signal },
    );
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const result = toResult(final, { allowRefusal: true });
      yield {
        type: 'end',
        usage: result.usage,
        model: result.model,
        stopReason: result.stopReason,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }
}

function usageOf(message: BetaMessage): LlmUsage {
  const u = message.usage;
  return {
    inputTokens:
      u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
}

function toResult(message: BetaMessage, opts: { allowRefusal?: boolean } = {}): LlmResult {
  const usage = usageOf(message);
  // Check the stop reason before reading content: a refused response's
  // content is empty or partial and must not be used.
  if (message.stop_reason === 'refusal' && !opts.allowRefusal) throw new LlmRefusalError(usage);
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const stopReason =
    message.stop_reason === 'end_turn' ||
    message.stop_reason === 'max_tokens' ||
    message.stop_reason === 'refusal'
      ? message.stop_reason
      : 'other';
  return { text, usage, model: message.model, stopReason };
}

function toProviderError(err: unknown): Error {
  if (err instanceof LlmRefusalError) return err;
  // Aborts (timeout / client went away) propagate untouched; the service
  // tells them apart by which signal fired.
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmUnavailableError('The AI provider timed out', 504);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmUnavailableError('The AI provider is rate limiting us, try again shortly', 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new LlmUnavailableError(`AI request rejected: ${err.message}`, 400);
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmUnavailableError('The AI provider is unavailable right now', err.status);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmUnavailableError('Could not reach the AI provider');
  }
  return err instanceof Error ? err : new Error(String(err));
}
