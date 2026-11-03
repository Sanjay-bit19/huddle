/**
 * Provider abstraction: the service layer (budgets, validation, retries,
 * grounding) is identical whether the model is Claude or the offline mock.
 */

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type Effort = 'low' | 'medium' | 'high';

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  effort: Effort;
  signal: AbortSignal;
}

export interface LlmJsonRequest extends LlmRequest {
  /** Shape-only JSON schema for structured output. */
  jsonSchema: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  /** Model that actually answered (may differ after a server-side fallback). */
  model: string;
  stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'other';
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'end'; usage: LlmUsage; model: string; stopReason: LlmResult['stopReason'] };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  completeJson(req: LlmJsonRequest): Promise<LlmResult>;
  streamText(req: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

/** The model declined (safety classifier). Not retried: same input, same answer. */
export class LlmRefusalError extends Error {
  constructor(public readonly usage: LlmUsage) {
    super('The AI declined this request');
  }
}

/** Upstream failure (network, 5xx, overload) after the SDK's own retries. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
