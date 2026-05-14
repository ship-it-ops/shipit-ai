'use client';

import { Button } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  type Responders,
  type ServiceNode,
  serviceContext,
} from '@/lib/incident/derivations';
import {
  getDeclareIncidentLinks,
  getTeamChannelLinks,
} from '@/lib/integrations';

interface Props {
  service: ServiceNode | undefined;
  responders: Responders;
}

/**
 * Sticky footer with the three persistent actions: declare an incident in
 * a configured incident-management tool, jump to the owning team's channel,
 * copy the dashboard link.
 *
 * Each link goes through the integration registry — if no PagerDuty/Slack
 * is configured, that button doesn't render. Customers see only the
 * actions their toolchain supports.
 */
export function IncidentFooter({ service, responders }: Props) {
  if (!service) return null;
  const ctx = serviceContext(service);
  const declareLinks = getDeclareIncidentLinks(ctx);
  const channelLinks = responders.owningTeams.flatMap((t) => getTeamChannelLinks(t));

  if (declareLinks.length === 0 && channelLinks.length === 0) return null;

  return (
    <footer className="border-border bg-bg/95 sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3 backdrop-blur">
      {declareLinks.map((link) => (
        <Button
          key={`declare-${link.url}`}
          asChild
          variant="destructive"
          size="sm"
          icon={<IconGlyph name="incident" size={11} />}
        >
          <a href={link.url} target="_blank" rel="noreferrer noopener">
            Declare in {link.integrationName}
          </a>
        </Button>
      ))}
      {channelLinks.map((link) => (
        <Button
          key={`channel-${link.url}`}
          asChild
          variant="outline"
          size="sm"
          icon={<IconGlyph name="mention" size={11} />}
        >
          <a href={link.url} target="_blank" rel="noreferrer noopener">
            {link.integrationName}
          </a>
        </Button>
      ))}
    </footer>
  );
}
