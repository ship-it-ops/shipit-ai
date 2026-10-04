import type { Redis } from 'ioredis';
import { RUN_EVENTS_CHANNEL, type RunEvent } from '@shipit-ai/agents';

/**
 * Announces run changes on Redis pub/sub for the api-server's stream endpoint.
 * Best-effort: a missed event only delays a viewer, who replays from Postgres.
 */
export class RedisRunEvents {
  constructor(
    private readonly redis: Redis,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  publish(event: RunEvent): void {
    this.redis
      .publish(RUN_EVENTS_CHANNEL, JSON.stringify(event))
      .catch((err: Error) => this.log(`run ${event.runId}: event not published: ${err.message}`));
  }
}
