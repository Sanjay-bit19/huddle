import type { Redis } from 'ioredis';
import { SERVER_EVENTS_CHANNEL, type ServerEvent } from '@huddle/shared';

export interface EventPublisher {
  publish(event: ServerEvent): Promise<void>;
}

export function redisEventPublisher(redis: Redis): EventPublisher {
  return {
    async publish(event) {
      await redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(event));
    },
  };
}
