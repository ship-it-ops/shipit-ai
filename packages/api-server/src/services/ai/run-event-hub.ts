// One Redis subscription for the whole api-server, fanned out to the open run
// streams. The runner publishes { runId, seq?, status? } on shipit-run-events
// after every write; a stream treats each one as "something changed, catch up
// from Postgres", so the events themselves never need to be complete.
import { RUN_EVENTS_CHANNEL, type RunEvent } from '@shipit-ai/agents';

/** The part of an ioredis subscriber connection the hub uses. */
export interface MessageSource {
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

type Listener = (event: RunEvent) => void;

export class RunEventHub {
  private readonly byRun = new Map<string, Set<Listener>>();

  constructor(source: MessageSource) {
    source.on('message', (channel, text) => {
      if (channel !== RUN_EVENTS_CHANNEL) return;
      let event: RunEvent;
      try {
        event = JSON.parse(text) as RunEvent;
      } catch {
        return;
      }
      for (const listener of this.byRun.get(event.runId) ?? []) listener(event);
    });
  }

  /** Calls `listener` for each event of one run. Returns the unsubscribe function. */
  subscribe(runId: string, listener: Listener): () => void {
    const set = this.byRun.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.byRun.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.byRun.delete(runId);
    };
  }

  /** How many streams follow a run. */
  listeners(runId: string): number {
    return this.byRun.get(runId)?.size ?? 0;
  }
}
