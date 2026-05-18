import { clientConfig } from '../client-config';
import type { IncidentIntegration, ServiceContext, TeamContext } from './types';

/**
 * Slack adapter.
 *
 * Configuration: `frontend.integrations.slack.workspace` in shipit.config.yaml
 * — the workspace subdomain (e.g., "acme" for https://acme.slack.com).
 * Optional `frontend.integrations.slack.channelPrefix` controls how team
 * slugs convert to channel names; default `team-` so `payments-team`
 * → `#team-payments-team`.
 *
 * Without a Slack bot token (Phase 2) we can't open a *new* incident
 * channel, but we can deeplink to the team's standing channel — the most
 * common ask in the persona research's Scenario C.
 */

function workspaceUrl(): string | null {
  const ws = clientConfig.integrations.slack.workspace;
  if (!ws) return null;
  return `https://${ws}.slack.com`;
}

export const slackAdapter: IncidentIntegration = {
  id: 'slack',
  name: 'Slack',

  isConfigured() {
    return Boolean(clientConfig.integrations.slack.workspace);
  },

  teamChannelUrl(team: TeamContext) {
    const url = workspaceUrl();
    if (!url) return null;
    const prefix = clientConfig.integrations.slack.channelPrefix;
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
