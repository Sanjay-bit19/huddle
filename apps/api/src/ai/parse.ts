import { notesToCardsOutputSchema, type NotesToCardsOutput } from '@huddle/shared';
import type { z } from 'zod';

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Pulls a JSON object out of a model response. Structured outputs make the
 * happy path a bare JSON document, but we stay tolerant of code fences or a
 * stray sentence (e.g. a provider without structured-output support).
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) throw new SyntaxError('no JSON object found');
    return JSON.parse(body.slice(start, end + 1));
  }
}

/** Compact, model-readable description of what was wrong (fed back on retry). */
export function describeIssues(error: z.ZodError, max = 8): string {
  return error.issues
    .slice(0, max)
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

export function parseStructured<S extends z.ZodType>(
  schema: S,
  raw: string,
): ParseResult<z.output<S>> {
  let value: unknown;
  try {
    value = extractJson(raw);
  } catch (err) {
    return { ok: false, error: `- (root): response is not valid JSON (${(err as Error).message})` };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: describeIssues(parsed.error) };
  return { ok: true, data: parsed.data };
}

export const parseNotesToCards = (raw: string): ParseResult<NotesToCardsOutput> =>
  parseStructured(notesToCardsOutputSchema, raw);
