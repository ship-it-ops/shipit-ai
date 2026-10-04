// The Redis wake-up subscription. It must never stand between the process and
// its loop: with Redis configured but unreachable, ioredis keeps `subscribe`
// pending until the connection comes back, so awaiting it would leave the
// worker idle for as long as Redis is down. The poll is the floor; the
// wake-up only shortens the wait (spec §Error handling, "Redis unavailable").
export interface WakeSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: () => void): unknown;
}

export function listenForWakeUps(
  subscriber: WakeSubscriber,
  channel: string,
  onWake: () => void,
  log: (line: string) => void,
): void {
  subscriber.on('message', onWake);
  void subscriber
    .subscribe(channel)
    .catch((err: Error) => log(`could not subscribe to ${channel}: ${err.message}`));
}
