import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_WAKE_CHANNEL, KNOWLEDGE_WORKER_HEARTBEAT_KEY } from '../channels.js';

// During a rolling deploy an api-server of one build publishes to a worker of
// another, and reads the heartbeat it writes. Renaming either name on one side
// would stop wake-ups silently, or fail the worker check for good.
describe('the names the api-server and the worker share', () => {
  it('are fixed', () => {
    expect(KNOWLEDGE_WAKE_CHANNEL).toBe('shipit-knowledge-wake');
    expect(KNOWLEDGE_WORKER_HEARTBEAT_KEY).toBe('shipit-knowledge-worker-heartbeat');
  });
});
