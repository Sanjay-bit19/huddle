import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { captureError } from '../observability';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    // Streaming responses (SSE) handle their own errors; just end the socket.
    res.end();
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid request', issues: err.issues },
    });
    return;
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      req.log.error({ err }, err.message);
      captureError(err, { requestId: req.id, path: req.path });
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  // body-parser errors carry a status (e.g. 400 malformed JSON, 413 too large).
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status < 500) {
    res.status(status).json({ error: { code: 'bad_request', message: err.message } });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  captureError(err, { requestId: req.id, path: req.path, userId: req.auth?.userId });
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};
