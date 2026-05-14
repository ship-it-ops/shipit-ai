'use client';

import { Card, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { EntityBadge } from '@ship-it-ui/shipit';
import {
  type Responders,
  type ServiceNode,
  serviceContext,
} from '@/lib/incident/derivations';
import { getPageOnCallLinks, getTeamChannelLinks } from '@/lib/integrations';

interface Props {
  service: ServiceNode | undefined;
  responders: Responders;
  loading?: boolean;
}

/**
 * Three-tier responder block.
 *
 * "Page now" (on-call human) is the largest, with the page-out button.
 * "Owning team" is medium, with channel + email actions.
 * "SMEs" (code owners) are smallest — labeled "wake if needed" because
 * the persona research is explicit that surfacing them as primary
 * responders pages the wrong human at 2 AM.
 */
export function IncidentResponders({ service, responders, loading }: Props) {
  const ctx = service ? serviceContext(service) : null;

  if (loading) {
    return (
      <Card title="Responders">
        <div className="flex h-24 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  const noResponders =
    responders.onCall.length === 0 &&
    responders.owningTeams.length === 0 &&
    responders.codeOwners.teams.length === 0 &&
    responders.codeOwners.people.length === 0;

  if (noResponders) {
    return (
      <Card title="Responders">
        <EmptyState
          tone="warn"
          icon={<IconGlyph name="warn" size={20} />}
          title="No responders configured"
          description="No on-call, owning team, or code owners are wired up for this service. Configure ownership in your catalog connector."
        />
      </Card>
    );
  }

  return (
    <Card title="Responders">
      <div className="flex flex-col gap-4">
        {/* Page now — on-call humans */}
        <section className="flex flex-col gap-2">
          <h3 className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">
            Page now
          </h3>
          {responders.onCall.length === 0 ? (
            <p className="text-text-muted text-[12px]">
              No on-call assigned. Page the owning team channel instead.
            </p>
          ) : (
            <ul className="m-0 flex flex-col gap-2 p-0">
              {responders.onCall.map((person) => {
                const pageLinks = ctx ? getPageOnCallLinks(person, ctx) : [];
                return (
                  <li
                    key={person.id}
                    className="border-border bg-panel-2 rounded-base flex flex-col gap-2 border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span className="bg-accent/20 text-accent grid h-8 w-8 place-items-center rounded-full text-[14px]">
                        <IconGlyph name="person" size={14} />
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="text-text font-medium">{person.name}</span>
                        <span className="text-text-dim font-mono text-[10px]">
                          {person.login ?? person.email ?? person.id}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {person.email && (
                        <a
                          href={`mailto:${person.email}`}
                          className="text-text-muted hover:text-accent inline-flex items-center gap-1 text-[11px]"
                        >
                          <IconGlyph name="mention" size={10} /> Email
                        </a>
                      )}
                      {pageLinks.map((link) => (
                        <a
                          key={link.url}
                          href={link.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="bg-err text-bg hover:bg-err/90 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[11px] font-medium"
                        >
                          <IconGlyph name="incident" size={11} />
                          Page via {link.integrationName}
                        </a>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Owning team(s) */}
        {responders.owningTeams.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">
              Owning team
            </h3>
            <ul className="m-0 flex flex-col gap-2 p-0">
              {responders.owningTeams.map((team) => {
                const channelLinks = getTeamChannelLinks(team);
                return (
                  <li
                    key={team.id}
                    className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <EntityBadge type="Team" />
                      <span className="text-text font-medium">{team.name}</span>
                      <span className="text-text-dim font-mono text-[10px]">
                        {team.slug}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      {team.email && (
                        <a
                          href={`mailto:${team.email}`}
                          className="text-text-muted hover:text-accent inline-flex items-center gap-1"
                        >
                          <IconGlyph name="mention" size={10} />
                          {team.email}
                        </a>
                      )}
                      {channelLinks.map((link) => (
                        <a
                          key={link.url}
                          href={link.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-text-muted hover:text-accent inline-flex items-center gap-1"
                        >
                          <IconGlyph name="mention" size={10} />
                          {link.integrationName} channel
                        </a>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Code owners (SMEs) */}
        {(responders.codeOwners.teams.length > 0 || responders.codeOwners.people.length > 0) && (
          <section className="flex flex-col gap-2">
            <h3 className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">
              SMEs · code owners (wake if needed)
            </h3>
            <div className="flex flex-wrap gap-2 text-[11px]">
              {responders.codeOwners.teams.map((t) => (
                <EntityBadge key={t.id} type="Team" label={t.name} />
              ))}
              {responders.codeOwners.people.map((p) => (
                <EntityBadge key={p.id} type="Person" label={p.name} />
              ))}
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}
