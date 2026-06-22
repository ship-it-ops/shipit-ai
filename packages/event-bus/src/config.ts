export interface EventBusConfig {
  redisUrl: string;
  queueName?: string;
  maxRetries?: number;
  retentionDays?: number;
  batchSize?: number;
  concurrency?: number;
  // The `shipit-event-log` Redis Stream is a replay-only audit buffer that
  // nothing currently consumes (`replay()` is never called — see the
  // replay-stream-wire-or-cut open question). It defaults OFF because a
  // time-bounded stream of full-entity event JSON is unbounded in BYTES and
  // grew to ~825 MB — the dominant share of the 2026-06-22 Redis OOM that
  // crashlooped api-server. Turn it on only alongside a real replay consumer.
  eventLogEnabled?: boolean;
  // Hard ceiling (approximate, `MAXLEN ~`) on the event-log stream's entry
  // count when it IS enabled, so it can never blow the Redis maxmemory ceiling
  // again regardless of event volume. Belt-and-suspenders with the time trim.
  eventLogMaxLen?: number;
}

export interface ResolvedConfig {
  redisHost: string;
  redisPort: number;
  queueName: string;
  maxRetries: number;
  retentionDays: number;
  batchSize: number;
  concurrency: number;
  eventLogEnabled: boolean;
  eventLogMaxLen: number;
}

export const DEFAULT_CONFIG = {
  queueName: 'shipit-events',
  maxRetries: 3,
  retentionDays: 7,
  batchSize: 500,
  concurrency: 1,
  // Off by default — see EventBusConfig.eventLogEnabled.
  eventLogEnabled: false,
  eventLogMaxLen: 10_000,
} as const satisfies Required<Omit<EventBusConfig, 'redisUrl'>>;

export function resolveConfig(config: EventBusConfig): ResolvedConfig {
  const url = new URL(config.redisUrl);
  return {
    redisHost: url.hostname,
    redisPort: Number(url.port) || 6379,
    queueName: config.queueName ?? DEFAULT_CONFIG.queueName,
    maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    retentionDays: config.retentionDays ?? DEFAULT_CONFIG.retentionDays,
    batchSize: config.batchSize ?? DEFAULT_CONFIG.batchSize,
    concurrency: config.concurrency ?? DEFAULT_CONFIG.concurrency,
    eventLogEnabled: config.eventLogEnabled ?? DEFAULT_CONFIG.eventLogEnabled,
    eventLogMaxLen: config.eventLogMaxLen ?? DEFAULT_CONFIG.eventLogMaxLen,
  };
}
