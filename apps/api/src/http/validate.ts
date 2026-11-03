import type { z } from 'zod';

/** Parses untrusted input; a ZodError becomes a 400 in the error handler. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}
