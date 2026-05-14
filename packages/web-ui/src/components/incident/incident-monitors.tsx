'use client';

import { Badge, Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { type MonitorEntry, monitorContext } from '@/lib/incident/derivations';
import { getMonitorLinks } from '@/lib/integrations';

interface Props {
  monitors: MonitorEntry[];
}

/**
 * Monitors panel.
 *
 * Phase 1 honesty constraint: we have monitor *definitions* in the catalog
 * (Monitor nodes via MONITORS edges), but no live firing state — the alert
 * state connector is Phase 2. So we don't render fake green checkmarks;
 * we surface the definition + a deeplink to the source system where the
 * IC can see real status. The empty state explains this explicitly.
 */
export function IncidentMonitors({ monitors }: Props) {
  if (monitors.length === 0) {
    return (
      <Card title="Monitors">
        <EmptyState
          icon={<IconGlyph name="incident" size={20} />}
          title="No monitors mapped"
          description="No Monitor entities link to this service in the catalog. Configure the alerting connector or add MONITORS edges."
        />
      </Card>
    );
  }

  return (
    <Card title={`Monitors · ${monitors.length}`}>
      <div className="flex flex-col gap-1">
        <p className="text-text-dim text-[10px]">
          Definitions only — live firing state requires the alert connector. Click through to view
          current status in the source system.
        </p>
        <ul className="m-0 flex flex-col p-0">
          {monitors.map((m, i) => {
            const links = getMonitorLinks(monitorContext(m));
            return (
              <li
                key={m.id}
                className={
                  'flex items-center gap-3 py-2 text-[12px] ' +
                  (i > 0 ? 'border-border border-t' : '')
                }
              >
                <span aria-hidden className="text-text-dim">
                  <IconGlyph name="incident" size={14} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-text truncate font-medium">{m.name}</span>
                  {(m.severity || m.runbookUrl) && (
                    <span className="text-text-dim flex flex-wrap items-center gap-2 text-[10px]">
                      {m.severity && (
                        <Badge variant="neutral" className="font-mono text-[10px]">
                          {m.severity}
                        </Badge>
                      )}
                      {m.runbookUrl && (
                        <a
                          href={m.runbookUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:text-accent inline-flex items-center gap-1"
                        >
                          <IconGlyph name="document" size={10} />
                          Runbook
                        </a>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {links.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-text-muted hover:text-accent inline-flex items-center gap-1 text-[11px]"
                    >
                      {link.integrationName}
                      <IconGlyph name="external" size={10} />
                    </a>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
