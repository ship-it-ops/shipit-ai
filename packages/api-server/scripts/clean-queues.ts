// One-time maintenance: purge accumulated completed/failed BullMQ job hashes
// from Redis. Written for the 2026-06-17 portal-demo OOM incident, where the
// dataset had crept to ~246 MB of mostly old job records (failed jobs were
// kept forever pre-fix). The retention fix bounds *new* jobs; this drains the
// existing backlog once.
//
// `queue.clean(grace, limit, type)` removes only completed/failed job hashes —
// it does NOT touch repeatable scheduler definitions, active jobs, or the
// event-log stream. Safe to run against a live cluster.
//
// Usage (after deploying the retention fix + infra's raised memory limit):
//   kubectl port-forward svc/redis 6379:6379 -n shipit
//   REDIS_URL=redis://localhost:6379 \
//     pnpm --filter @shipit-ai/api-server exec tsx scripts/clean-queues.ts
//
// Set DRY_RUN=1 to count what would be removed without deleting.
import { Queue, type ConnectionOptions } from 'bullmq';

const QUEUES = ['shipit-events', 'shipit-sync-github'];
const BATCH = 10_000;

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}

async function main(): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const dryRun = process.env.DRY_RUN === '1';
  const connection = parseRedisUrl(url);
  const target = new URL(url);
  console.log(`[clean-queues] target=${target.hostname}:${target.port || 6379} dryRun=${dryRun}`);

  for (const name of QUEUES) {
    const queue = new Queue(name, { connection });
    try {
      for (const type of ['completed', 'failed'] as const) {
        if (dryRun) {
          const count = await queue.getJobCountByTypes(type);
          console.log(`[clean-queues] ${name}/${type}: ${count} job(s) (dry run, not removed)`);
          continue;
        }
        let total = 0;
        // clean() returns the ids removed this pass; loop until a pass is empty
        // so we drain backlogs larger than BATCH.
        for (;;) {
          const removed = await queue.clean(0, BATCH, type);
          total += removed.length;
          if (removed.length < BATCH) break;
        }
        console.log(`[clean-queues] ${name}/${type}: removed ${total} job(s)`);
      }
    } finally {
      await queue.close();
    }
  }
  console.log('[clean-queues] done');
}

main().catch((err) => {
  console.error('[clean-queues] failed:', err);
  process.exitCode = 1;
});
