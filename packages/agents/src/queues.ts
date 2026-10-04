// Names the api-server and the agent runner must agree on. No colons anywhere:
// BullMQ 5 rejects them in queue names and job ids (scar
// bullmq-5-forbids-colons-in-queue-names-and-job-ids).
import type { RunStatus } from './run-store.js';

/** BullMQ queue of runs to work on. Jobs carry only the run id; state lives in Postgres. */
export const AGENT_RUNS_QUEUE = 'shipit-agent-runs';

export interface RunJob {
  runId: string;
}

/** Redis pub/sub channel: the runner announces each write to a run here. */
export const RUN_EVENTS_CHANNEL = 'shipit-run-events';

export interface RunEvent {
  runId: string;
  /** Set when messages were appended: the highest new sequence number. */
  seq?: number;
  status?: RunStatus;
}

/** Written by the runner every 15 s with a 60 s TTL; GET /ai/status reads it. */
export const RUNNER_HEARTBEAT_KEY = 'shipit-agent-runner-heartbeat';
