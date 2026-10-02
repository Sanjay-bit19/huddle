import { z } from 'zod';

// ---------------------------------------------------------------------------
// Requests (HTTP boundary)
// ---------------------------------------------------------------------------

export const notesToCardsRequestSchema = z.object({
  notes: z.string().trim().min(1, 'Paste some notes first').max(20_000, 'Notes are too long'),
});

export const askRequestSchema = z.object({
  question: z.string().trim().min(1, 'Ask a question').max(500),
});

// ---------------------------------------------------------------------------
// LLM output (model boundary): everything the model returns is untrusted
// until it passes this schema. The JSON schema sent to the API only
// constrains the *shape* (structured outputs do not support length or count
// limits); every real constraint is enforced here.
// ---------------------------------------------------------------------------

export const proposedCardSchema = z
  .object({
    title: z.string().trim().min(1, 'title must not be empty').max(200),
    description: z.string().max(2000),
    column: z.string().max(120),
    labels: z.array(z.string().trim().min(1).max(32)).max(5),
    dueDate: z.iso.date().nullable(),
    assignees: z.array(z.string().max(80)).max(5),
    checklist: z.array(z.string().trim().min(1).max(300)).max(10),
  })
  .strict();

export const notesToCardsOutputSchema = z
  .object({
    cards: z.array(proposedCardSchema).max(25, 'propose at most 25 cards'),
  })
  .strict();
export type NotesToCardsOutput = z.infer<typeof notesToCardsOutputSchema>;

/** Shape-only JSON schema for the API's structured output (stable, so it caches). */
export const notesToCardsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'column', 'labels', 'dueDate', 'assignees', 'checklist'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          column: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          dueDate: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          assignees: { type: 'array', items: { type: 'string' } },
          checklist: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Responses (to the browser)
// ---------------------------------------------------------------------------

export interface CardProposal {
  title: string;
  description: string;
  columnId: string;
  columnTitle: string;
  labels: string[];
  dueDate: string | null;
  assignees: Array<{ userId: string; name: string }>;
  checklist: string[];
}

export interface NotesToCardsResponse {
  proposals: CardProposal[];
  warnings: string[];
  usage: { inputTokens: number; outputTokens: number };
  attempts: number;
}

export interface AiStatus {
  provider: string;
  model: string;
  budget: { used: number; reserved: number; limit: number; period: string; resetsAt: string };
}

export const citationSchema = z.object({
  ref: z.string(),
  cardId: z.string(),
  title: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

const usageSchema = z.object({ inputTokens: z.number(), outputTokens: z.number() });

/**
 * Server-Sent Events emitted by the streaming AI endpoints. The server builds
 * them with this type and the browser validates each one with this schema.
 */
export const aiStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('meta'),
    data: z.object({ provider: z.string(), model: z.string(), cards: z.number() }),
  }),
  z.object({ event: z.literal('delta'), data: z.object({ text: z.string() }) }),
  z.object({
    event: z.literal('citations'),
    data: z.object({ citations: z.array(citationSchema), invalid: z.array(z.string()) }),
  }),
  z.object({ event: z.literal('refusal'), data: z.object({ message: z.string() }) }),
  z.object({
    event: z.literal('done'),
    data: z.object({ usage: usageSchema, truncated: z.boolean() }),
  }),
  z.object({
    event: z.literal('error'),
    data: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type AiStreamEvent = z.infer<typeof aiStreamEventSchema>;

/** Card references the model uses to cite cards: [C1], [C12]... */
export const CITATION_PATTERN = /\[(C\d{1,4})\]/g;
