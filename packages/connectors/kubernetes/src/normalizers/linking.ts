import type { KubernetesMappingConfig } from '@shipit-ai/shared';
import { slugify, type ParsedImage } from './identity.js';

export type LinkMethod = 'annotation' | 'image-name' | 'app-label';

export interface RepositoryLink {
  org: string;
  repo: string;
  confidence: number;
  linkMethod: LinkMethod;
}

export interface LinkResult<T> {
  link: T | null;
  warnings: string[];
}

export interface RepositoryLinkInput {
  annotations: Record<string, string>;
  namespaceAnnotations: Record<string, string>;
  labels: Record<string, string>;
  images: ParsedImage[];
  mapping: KubernetesMappingConfig['repoLink'];
  /** Repository names already in the graph for `githubOrg` (source casing). */
  knownRepositories: string[];
  githubOrg: string | null;
}

const ANNOTATION_VALUE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const CONFIDENCE: Record<LinkMethod, number> = {
  annotation: 1.0,
  'image-name': 0.7,
  'app-label': 0.6,
};

function findKnown(candidate: string, known: string[]): string | undefined {
  const lower = candidate.toLowerCase();
  return known.find((k) => k.toLowerCase() === lower);
}

/**
 * Spec §Repository linking tiers. Tier 1 needs no graph knowledge (the operator
 * names the repo). Tiers 2–3 need `githubOrg` and compare against
 * `knownRepositories` so the predicted id carries the repo's real casing.
 */
export function resolveRepositoryLink(input: RepositoryLinkInput): LinkResult<RepositoryLink> {
  const warnings: string[] = [];
  const key = input.mapping.annotation;
  const raw = input.annotations[key] ?? input.namespaceAnnotations[key];
  if (raw !== undefined) {
    const m = raw.trim().match(ANNOTATION_VALUE);
    if (m) {
      return {
        link: {
          org: m[1],
          repo: m[2],
          confidence: CONFIDENCE.annotation,
          linkMethod: 'annotation',
        },
        warnings,
      };
    }
    warnings.push(`ignored ${key}="${raw}": expected <org>/<repo>`);
  }
  if (!input.mapping.nameMatch) return { link: null, warnings };
  if (!input.githubOrg) {
    warnings.push(
      'repoLink.githubOrg unresolved: name-match tiers disabled (set mapping.repoLink.githubOrg or configure exactly one GitHub connector)',
    );
    return { link: null, warnings };
  }
  for (const image of input.images) {
    const hit = findKnown(image.name, input.knownRepositories);
    if (hit) {
      return {
        link: {
          org: input.githubOrg,
          repo: hit,
          confidence: CONFIDENCE['image-name'],
          linkMethod: 'image-name',
        },
        warnings,
      };
    }
  }
  const appName =
    input.labels['app.kubernetes.io/name'] ?? input.labels['app.kubernetes.io/part-of'];
  if (appName) {
    const hit = findKnown(appName, input.knownRepositories);
    if (hit) {
      return {
        link: {
          org: input.githubOrg,
          repo: hit,
          confidence: CONFIDENCE['app-label'],
          linkMethod: 'app-label',
        },
        warnings,
      };
    }
  }
  return { link: null, warnings };
}

export interface TeamLink {
  org: string;
  slug: string;
  confidence: number;
  derivedFrom: 'label' | 'namespace-label';
}

/** Spec §Ownership: team label on the workload, else namespace; slugified; must be a known team. */
export function resolveTeamLink(input: {
  labels: Record<string, string>;
  namespaceLabels: Record<string, string>;
  teamLabel: string;
  knownTeams: string[];
  githubOrg: string | null;
}): LinkResult<TeamLink> {
  const warnings: string[] = [];
  const fromWorkload = input.labels[input.teamLabel]?.trim();
  const fromNamespace = input.namespaceLabels[input.teamLabel]?.trim();
  const raw = fromWorkload || fromNamespace;
  if (!raw) return { link: null, warnings };
  if (!input.githubOrg) {
    warnings.push(`team label "${raw}" ignored: repoLink.githubOrg unresolved`);
    return { link: null, warnings };
  }
  const hit = findKnown(slugify(raw), input.knownTeams);
  if (!hit) {
    warnings.push(`team label "${raw}" matches no GitHub team in ${input.githubOrg}`);
    return { link: null, warnings };
  }
  return {
    link: {
      org: input.githubOrg,
      slug: hit,
      confidence: 0.85,
      derivedFrom: fromWorkload ? 'label' : 'namespace-label',
    },
    warnings,
  };
}
