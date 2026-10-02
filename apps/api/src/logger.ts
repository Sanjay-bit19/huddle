import { pino, type Logger } from 'pino';

export function createLogger(
  level: string,
  pretty = process.env.NODE_ENV === 'development',
): Logger {
  return pino({
    level,
    base: { service: 'api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.accessToken',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

export type { Logger };
