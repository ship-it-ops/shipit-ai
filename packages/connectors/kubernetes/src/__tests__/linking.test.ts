import { describe, it, expect } from 'vitest';
import { resolveRepositoryLink, resolveTeamLink } from '../normalizers/linking.js';
import { parseImageRef } from '../normalizers/identity.js';

const mapping = {
  annotation: 'shipit.ai/github-repo',
  githubOrg: null as string | null,
  nameMatch: true,
};
const base = {
  annotations: {},
  namespaceAnnotations: {},
  labels: {},
  images: [] as ReturnType<typeof parseImageRef>[],
  mapping,
  knownRepositories: ['ShipIt-AI', 'api-server'],
  githubOrg: 'Ship-It-Ops' as string | null,
};

describe('resolveRepositoryLink', () => {
  it('tier 1: the workload annotation wins at confidence 1.0 with the exact org/repo', () => {
    const r = resolveRepositoryLink({
      ...base,
      annotations: { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
      labels: { 'app.kubernetes.io/name': 'something-else' },
    });
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      repo: 'ShipIt-AI',
      confidence: 1.0,
      linkMethod: 'annotation',
    });
    expect(r.warnings).toEqual([]);
  });

  it('tier 1 falls back to the namespace annotation', () => {
    const r = resolveRepositoryLink({
      ...base,
      namespaceAnnotations: { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
    });
    expect(r.link?.linkMethod).toBe('annotation');
  });

  it('a malformed annotation is ignored with a warning and the tiers continue', () => {
    const r = resolveRepositoryLink({
      ...base,
      annotations: { 'shipit.ai/github-repo': 'not a slug' },
      images: [parseImageRef('us-central1-docker.pkg.dev/p/shipit-ai/api-server:sha-1')],
    });
    expect(r.warnings[0]).toMatch(/ignored shipit.ai\/github-repo="not a slug"/);
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      repo: 'api-server',
      confidence: 0.7,
      linkMethod: 'image-name',
    });
  });

  it('tier 3: app label matches a known repository case-insensitively and uses the known casing', () => {
    const r = resolveRepositoryLink({ ...base, labels: { 'app.kubernetes.io/name': 'shipit-ai' } });
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      repo: 'ShipIt-AI',
      confidence: 0.6,
      linkMethod: 'app-label',
    });
  });

  it('tier 3 also accepts app.kubernetes.io/part-of', () => {
    const r = resolveRepositoryLink({
      ...base,
      labels: { 'app.kubernetes.io/part-of': 'SHIPIT-AI' },
    });
    expect(r.link?.repo).toBe('ShipIt-AI');
  });

  it('name tiers are disabled with a warning when githubOrg is unresolved, and when nameMatch is off', () => {
    const noOrg = resolveRepositoryLink({
      ...base,
      githubOrg: null,
      labels: { 'app.kubernetes.io/name': 'shipit-ai' },
    });
    expect(noOrg.link).toBeNull();
    expect(noOrg.warnings[0]).toMatch(/githubOrg unresolved/);
    const off = resolveRepositoryLink({
      ...base,
      mapping: { ...mapping, nameMatch: false },
      labels: { 'app.kubernetes.io/name': 'shipit-ai' },
    });
    expect(off.link).toBeNull();
    expect(off.warnings).toEqual([]);
  });

  it('returns null without warnings when nothing matches', () => {
    const r = resolveRepositoryLink({ ...base, labels: { 'app.kubernetes.io/name': 'unknown' } });
    expect(r).toEqual({ link: null, warnings: [] });
  });
});

describe('resolveTeamLink', () => {
  it('slugifies the label and returns the known team slug at 0.85', () => {
    const r = resolveTeamLink({
      labels: { team: 'Platform Team' },
      namespaceLabels: {},
      teamLabel: 'team',
      knownTeams: ['platform-team'],
      githubOrg: 'Ship-It-Ops',
    });
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      slug: 'platform-team',
      confidence: 0.85,
      derivedFrom: 'label',
    });
  });

  it('falls back to the namespace label and warns on an unknown team', () => {
    const r = resolveTeamLink({
      labels: {},
      namespaceLabels: { team: 'payments' },
      teamLabel: 'team',
      knownTeams: ['platform-team'],
      githubOrg: 'Ship-It-Ops',
    });
    expect(r.link).toBeNull();
    expect(r.warnings[0]).toMatch(/matches no GitHub team/);
    const ok = resolveTeamLink({
      labels: {},
      namespaceLabels: { team: 'payments' },
      teamLabel: 'team',
      knownTeams: ['payments'],
      githubOrg: 'Ship-It-Ops',
    });
    expect(ok.link?.derivedFrom).toBe('namespace-label');
  });
});
