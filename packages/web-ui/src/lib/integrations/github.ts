import type { IncidentIntegration, RepositoryContext, ServiceContext } from './types';

/**
 * GitHub adapter.
 *
 * Configuration: `NEXT_PUBLIC_GITHUB_ORG` (the org slug, e.g., "ship-it-ops").
 * Many repos in the catalog already carry their own canonical `url` — when
 * present we prefer that; the org override is a fallback for repos that
 * never got URL metadata seeded.
 *
 * GitHub is the SRE's most-clicked deeplink during triage (per persona
 * research: "the #1 thing I open is the repo to look at recent merges"),
 * so the adapter's `isConfigured()` returns true if EITHER the org is set
 * OR a per-repo URL is supplied.
 */
export const gitHubAdapter: IncidentIntegration = {
  id: 'github',
  name: 'GitHub',

  isConfigured() {
    // Always considered configured — the per-repo URL fallback works without
    // org config. The repository panel hides itself when neither the URL
    // property nor the org are usable.
    return true;
  },

  repositoryUrl(repo: RepositoryContext) {
    if (repo.url) return repo.url;
    const org = process.env.NEXT_PUBLIC_GITHUB_ORG;
    if (!org) return null;
    return `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repo.name)}`;
  },

  // Service-level GitHub link == its primary repository's recent commits.
  // The dashboard composer resolves the repo via the IMPLEMENTED_BY edge
  // before calling this; we just shape the URL given that repo context.
  serviceDashboardUrl(service: ServiceContext) {
    const org = process.env.NEXT_PUBLIC_GITHUB_ORG;
    if (!org) return null;
    return `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(service.name)}/commits`;
  },
};
