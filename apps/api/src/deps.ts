import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { Database } from '@huddle/db';
import { BudgetStore } from './ai/budget';
import { AnthropicProvider } from './ai/providers/anthropic';
import { MockProvider } from './ai/providers/mock';
import type { LlmProvider } from './ai/providers/types';
import { AiService } from './ai/service';
import { AuthService } from './auth/service';
import type { Config } from './config';
import type { EventPublisher } from './events';
import { requireAuth } from './http/auth-middleware';
import type { Logger } from './logger';
import { createApiMetrics, type ApiMetrics } from './metrics';

export interface AppDeps {
  config: Config;
  db: Database;
  redis: Redis;
  logger: Logger;
  events: EventPublisher;
  auth: AuthService;
  requireAuth: RequestHandler;
  metrics: ApiMetrics;
  ai: { service: AiService; budget: BudgetStore };
}

export interface BaseDeps {
  config: Config;
  db: Database;
  redis: Redis;
  logger: Logger;
  events: EventPublisher;
  /** Override the LLM (tests inject a mock or a scripted provider). */
  llm?: LlmProvider;
}

export function createProvider(config: Config): LlmProvider {
  if (config.AI_PROVIDER === 'anthropic') {
    return new AnthropicProvider(config.AI_MODEL, {
      timeoutMs: config.AI_TIMEOUT_MS,
      fallbacks: config.AI_FALLBACKS,
      apiKey: config.ANTHROPIC_API_KEY,
    });
  }
  return new MockProvider();
}

export function buildDeps(base: BaseDeps): AppDeps {
  const metrics = createApiMetrics();
  const budget = new BudgetStore(base.db, base.config.AI_MONTHLY_TOKEN_BUDGET);
  const service = new AiService({
    db: base.db,
    provider: base.llm ?? createProvider(base.config),
    budget,
    metrics,
    logger: base.logger,
    timeoutMs: base.config.AI_TIMEOUT_MS,
  });
  return {
    ...base,
    metrics,
    ai: { service, budget },
    auth: new AuthService(base.db, base.config, base.events, base.logger),
    requireAuth: requireAuth(base.db, base.config.JWT_SECRET),
  };
}
