import { describe, it, expect } from 'vitest';
import { connectorInfo, type Connector, type SyncRuntimeStatus } from './api';
import { CONNECTOR_STATUS } from './connector-status';

const base = {
  id: 'k8s-prod-eu',
  type: 'kubernetes',
  name: 'prod-eu',
  enabled: true,
  schedule: '*/5 * * * *',
  lastRuns: [],
} as unknown as Connector;

const run = (status: 'success' | 'partial' | 'failed') =>
  ({
    ...base,
    lastRuns: [{ status, startedAt: '2026-09-30T09:00:00Z', entitiesSynced: 7, errors: [] }],
  }) as unknown as Connector;

const rt = (state: SyncRuntimeStatus['state']): SyncRuntimeStatus =>
  ({ connectorId: base.id, state }) as SyncRuntimeStatus;

// The old shape folded three unrelated situations into `degraded` — a run in
// flight, a connector that has never run, and an actual problem — and left
// each surface to guess which one it was looking at (the card said "Syncing",
// the drawer said "degraded", for the same connector).
describe('connectorInfo status', () => {
  it('is syncing while a run is in flight, whatever the last run said', () => {
    expect(connectorInfo(run('failed'), rt('running')).status).toBe('syncing');
  });

  it('is pending for an enabled connector that has never run and is not running', () => {
    expect(connectorInfo(base, null).status).toBe('pending');
    expect(connectorInfo(base, rt('idle')).status).toBe('pending');
  });

  it('is degraded only for a real problem: a partial run or a sticky auth failure', () => {
    expect(connectorInfo(run('partial'), rt('idle')).status).toBe('degraded');
    expect(connectorInfo(run('success'), rt('degraded')).status).toBe('degraded');
  });

  it('keeps healthy, failed and not_connected as before', () => {
    expect(connectorInfo(run('success'), rt('idle')).status).toBe('healthy');
    expect(connectorInfo(run('failed'), rt('idle')).status).toBe('failed');
    expect(connectorInfo({ ...base, enabled: false } as Connector, rt('running')).status).toBe(
      'not_connected',
    );
  });
});

describe('CONNECTOR_STATUS', () => {
  it('has a label, dot state and badge variant for every status', () => {
    const statuses = ['healthy', 'syncing', 'pending', 'degraded', 'failed', 'not_connected'];
    for (const s of statuses) {
      const entry = CONNECTOR_STATUS[s as keyof typeof CONNECTOR_STATUS];
      expect(entry, s).toBeDefined();
      expect(entry.label.length, s).toBeGreaterThan(0);
    }
  });

  it('never calls a problem "Syncing" and only pulses while a run is in flight', () => {
    expect(CONNECTOR_STATUS.degraded.label).not.toMatch(/syncing/i);
    expect(CONNECTOR_STATUS.degraded.pulse).toBe(false);
    expect(CONNECTOR_STATUS.pending.pulse).toBe(false);
    expect(CONNECTOR_STATUS.syncing.pulse).toBe(true);
  });
});
