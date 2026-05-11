export enum SyncState {
  IDLE = 'IDLE',
  SYNCING = 'SYNCING',
  COMPLETING = 'COMPLETING',
  FAILED = 'FAILED',
  DEGRADED = 'DEGRADED',
}

type SyncTransition =
  | { from: SyncState.IDLE; to: SyncState.SYNCING }
  | { from: SyncState.SYNCING; to: SyncState.COMPLETING }
  | { from: SyncState.SYNCING; to: SyncState.FAILED }
  | { from: SyncState.SYNCING; to: SyncState.DEGRADED }
  | { from: SyncState.COMPLETING; to: SyncState.IDLE }
  | { from: SyncState.COMPLETING; to: SyncState.FAILED }
  | { from: SyncState.COMPLETING; to: SyncState.DEGRADED }
  | { from: SyncState.FAILED; to: SyncState.IDLE }
  | { from: SyncState.DEGRADED; to: SyncState.IDLE }
  | { from: SyncState.DEGRADED; to: SyncState.SYNCING };

const VALID_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  `${SyncState.IDLE}->${SyncState.SYNCING}`,
  `${SyncState.SYNCING}->${SyncState.COMPLETING}`,
  `${SyncState.SYNCING}->${SyncState.FAILED}`,
  `${SyncState.SYNCING}->${SyncState.DEGRADED}`,
  `${SyncState.COMPLETING}->${SyncState.IDLE}`,
  `${SyncState.COMPLETING}->${SyncState.FAILED}`,
  `${SyncState.COMPLETING}->${SyncState.DEGRADED}`,
  `${SyncState.FAILED}->${SyncState.IDLE}`,
  `${SyncState.DEGRADED}->${SyncState.IDLE}`,
  `${SyncState.DEGRADED}->${SyncState.SYNCING}`,
]);

export class SyncStateMachine {
  private _state: SyncState = SyncState.IDLE;
  private _lastTransition: string | null = null;

  get state(): SyncState {
    return this._state;
  }

  get lastTransition(): string | null {
    return this._lastTransition;
  }

  transition(to: SyncState): void {
    const key = `${this._state}->${to}`;
    if (!VALID_TRANSITIONS.has(key)) {
      throw new Error(`Invalid sync state transition: ${this._state} -> ${to}`);
    }
    this._lastTransition = new Date().toISOString();
    this._state = to;
  }

  reset(): void {
    this._state = SyncState.IDLE;
    this._lastTransition = null;
  }

  canTransitionTo(to: SyncState): boolean {
    return VALID_TRANSITIONS.has(`${this._state}->${to}`);
  }
}

// Re-export the transition type for external use
export type { SyncTransition };
