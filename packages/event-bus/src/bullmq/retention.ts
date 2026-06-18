// Bounded BullMQ job retention. Without these, completed/failed job hashes
// accumulate in Redis forever — the 2026-06-17 portal-demo incident, where the
// dataset crept to ~246 MB and OOMKilled redis. `removeOnFail: false` (the old
// default) was the worst offender: failed jobs were kept indefinitely, each
// carrying its full entity payload.
//
// Values are the "recommended balance" policy: keep failures long enough to
// debug, completed history short. `age` is in seconds; `count` caps the set
// size regardless of age. Shapes satisfy BullMQ's KeepJobs type.

/** Failed jobs: keep 7 days, capped at 5,000. Shared by every queue. */
export const FAILED_JOB_RETENTION = { age: 7 * 24 * 3600, count: 5000 } as const;

/** Completed jobs: keep 24h, capped at 1,000. Used where completed history is
 *  worth auditing (the sync scheduler). The event-bus queue removes completed
 *  jobs immediately instead — the event-log stream is its audit trail. */
export const COMPLETED_JOB_RETENTION = { age: 24 * 3600, count: 1000 } as const;
