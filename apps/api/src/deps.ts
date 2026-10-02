import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { Database } from '@huddle/db';
import { AuthService } from './auth/service';
import type { Config } from './config';
import type { EventPublisher } from './events';
import { requireAuth } from './http/auth-middleware';
import type { Logger } from './logger';

export interface AppDeps {
  config: Config;
  db: Database;
  redis: Redis;
  logger: Logger;
  events: EventPublisher;
  auth: AuthService;
  requireAuth: RequestHandler;
}

export interface BaseDeps {
  config: Config;
  db: Database;
  redis: Redis;
  logger: Logger;
  events: EventPublisher;
}

export function buildDeps(base: BaseDeps): AppDeps {
  return {
    ...base,
    auth: new AuthService(base.db, base.config, base.events, base.logger),
    requireAuth: requireAuth(base.db, base.config.JWT_SECRET),
  };
}
