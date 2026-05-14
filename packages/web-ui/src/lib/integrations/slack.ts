import type { IncidentIntegration, ServiceContext, TeamContext } from './types';

/**
 * Slack adapter.
 *
 * Configuration: `NEXT_PUBLIC_SLACK_WORKSPACE` — the workspace subdomain
 * (e.g., "acme" for https://acme.slack.com). Optional
 * `NEXT_PUBLIC_SLACK_CHANNEL_PREFIX` controls how team slugs convert to
 * channel names; default `team-` so `payments-team` → `#team-payments-team`.
 *
 * Without a Slack bot token (Phase 2) we can't open a *new* incident
 * channel, but we can deeplink to the team's standing channel — the most
 * common ask in the persona research's Scenario C.
 */

const DEFAULT_CHANNEL_PREFIX = 'team-';

function workspaceUrl(): string | null {
  const ws = process.env.NEXT_PUBLIC_SLACK_WORKSPACE;
  if (!ws) return null;
  return `https://${ws}.slack.com`;
}

export const slackAdapter: IncidentIntegration = {
  id: 'slack',
  name: 'Slack',

  isConfigured() {
    return Boolean(process.env.NEXT_PUBLIC_SLACK_WORKSPACE);
  },

  teamChannelUrl(team: TeamContext) {
    const url = workspaceUrl();
    if (!url) return null;
    const prefix = process.env.NEXT_PUBLIC_SLACK_CHANNEL_PREFIX ?? DEFAULT_CHANNEL_PREFIX;
    // Team slugs in the catalog look like "payments-team"; strip a trailing
    // "-team" suffix so we get "#team-payments" not "#team-payments-team".
    const slug = team.slug.replace(/-team$/, '');
    const channel = `${prefix}${slug}`;
    return `${url}/app_redirect?channel=${encodeURIComponent(channel)}`;
  },

  // No service-level Slack action in Phase 1 — channel creation requires the
  // Phase 2 bot token. Returning null lets the dashboard fall back to the
  // owning team's standing channel via teamChannelUrl.
  serviceDashboardUrl(_service: ServiceContext) {
    return null;
  },
};
