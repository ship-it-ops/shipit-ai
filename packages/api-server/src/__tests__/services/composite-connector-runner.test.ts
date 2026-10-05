import { describe, it, expect, vi } from 'vitest';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { CompositeConnectorRunner } from '../../services/composite-connector-runner.js';

const gh = { id: 'gh', type: 'github', enabled: true } as unknown as ConnectorInstanceConfig;
const slack = { id: 'sl', type: 'slack', enabled: true } as unknown as ConnectorInstanceConfig;

function fakes() {
  const graph = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    triggerSync: vi.fn(async (c: ConnectorInstanceConfig) => ({
      connectorId: c.id,
      state: 'running' as const,
    })),
    getStatus: vi.fn((id: string) => ({ connectorId: id, state: 'idle' as const })),
  };
  const knowledge = {
    handles: vi.fn((c: ConnectorInstanceConfig) => c.type !== 'kubernetes'),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    trigger: vi.fn(async (c: ConnectorInstanceConfig) => ({
      connectorId: c.id,
      state: 'running' as const,
    })),
    getStatus: vi.fn((id: string) => ({
      connectorId: id,
      state: 'degraded' as const,
      lastError: 'token expired',
    })),
  };
  return { graph, knowledge };
}

describe('CompositeConnectorRunner', () => {
  it('starts and stops both facets', async () => {
    const { graph, knowledge } = fakes();
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    await runner.start(gh);
    await runner.stop('gh');
    expect(graph.start).toHaveBeenCalledWith(gh);
    expect(knowledge.start).toHaveBeenCalledWith(gh);
    expect(graph.stop).toHaveBeenCalledWith('gh');
    expect(knowledge.stop).toHaveBeenCalledWith('gh');
  });

  it('a manual sync reaches every facet the connector has', async () => {
    const { graph, knowledge } = fakes();
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    await runner.triggerSync(gh, 'incremental');
    expect(graph.triggerSync).toHaveBeenCalledOnce();
    expect(knowledge.trigger).toHaveBeenCalledWith(gh, 'poll');
    await runner.triggerSync(slack, 'full');
    expect(knowledge.trigger).toHaveBeenCalledWith(slack, 'reconcile');
  });

  it('still starts and stops the knowledge facet when the graph facet throws', async () => {
    const { graph, knowledge } = fakes();
    graph.start.mockRejectedValueOnce(new Error('redis down'));
    graph.stop.mockRejectedValueOnce(new Error('redis down'));
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    await expect(runner.start(gh)).rejects.toThrow('redis down');
    expect(knowledge.start).toHaveBeenCalledWith(gh);
    await expect(runner.stop('gh')).rejects.toThrow('redis down');
    expect(knowledge.stop).toHaveBeenCalledWith('gh');
  });

  it('reports the knowledge status for knowledge-only types and the graph status otherwise', () => {
    const { graph, knowledge } = fakes();
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    expect(runner.getStatus('gh').state).toBe('idle');
    runner.remember(slack);
    expect(runner.getStatus('sl')).toMatchObject({ state: 'degraded', lastError: 'token expired' });
  });

  it('is inert for a facet that is not wired', async () => {
    const runner = new CompositeConnectorRunner({
      graph: null,
      knowledge: null,
      hasGraphFacet: () => true,
    });
    await runner.start(gh);
    expect((await runner.triggerSync(gh, 'full')).state).toBe('idle');
    expect(runner.getStatus('gh').state).toBe('idle');
  });
});
