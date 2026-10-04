import { describe, it, expect } from 'vitest';
import { connectorInstanceSchema } from '../config/index.js';

const parseConnectorInstance = (value: unknown) => connectorInstanceSchema.parse(value);

const base = { id: 'gh-1', type: 'github', name: 'acme', installationId: '1', org: 'acme' };

describe('GitHub connector knowledge block', () => {
  it('is off by default, with every default the spec lists', () => {
    const cfg = parseConnectorInstance(base);
    if (cfg.type !== 'github') throw new Error('expected a github connector');
    expect(cfg.knowledge).toEqual({
      enabled: false,
      pullRequests: true,
      issues: true,
      docs: {
        enabled: true,
        paths: ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md'],
        maxFileBytes: 200000,
      },
      historyDays: 365,
    });
  });

  it('fills the rest when only a part is given', () => {
    const cfg = parseConnectorInstance({ ...base, knowledge: { enabled: true, issues: false } });
    if (cfg.type !== 'github') throw new Error('expected a github connector');
    expect(cfg.knowledge.enabled).toBe(true);
    expect(cfg.knowledge.issues).toBe(false);
    expect(cfg.knowledge.docs.maxFileBytes).toBe(200000);
  });

  it('rejects a negative history and an empty path', () => {
    expect(() => parseConnectorInstance({ ...base, knowledge: { historyDays: -1 } })).toThrow();
    expect(() =>
      parseConnectorInstance({ ...base, knowledge: { docs: { paths: [''] } } }),
    ).toThrow();
  });
});
