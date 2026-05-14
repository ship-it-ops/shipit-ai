'use client';

import { useRouter } from 'next/navigation';
import { Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import { EntitySearchBox } from '@/components/search/entity-search-box';
import { useRecentlyViewed } from '@/lib/hooks/use-recently-viewed';

/**
 * Incident Mode landing page.
 *
 * Shown when the user opens /incidents without a service selected. The
 * search box drops them into the per-service dashboard at
 * /incidents/[serviceId]; "recently viewed" is hydrated from localStorage
 * so multi-page incidents don't force re-typing.
 */
export default function IncidentModeLandingPage() {
  const router = useRouter();
  const { entries, clear } = useRecentlyViewed();

  return (
    <div className="flex h-full flex-col items-center justify-start overflow-y-auto p-6">
      <div className="w-full max-w-2xl space-y-6 pt-12">
        <EmptyState
          tone="err"
          icon={<IconGlyph name="incident" size={22} />}
          title="Incident Mode"
          description="Pick the affected service. The dashboard pulls together responders, blast radius, recent changes, and deeplinks into your incident tools."
        />

        <EntitySearchBox
          autoFocus
          size="lg"
          preferLabel="LogicalService"
          placeholder="What service is having problems?"
          onSelect={(result) => router.push(`/incidents/${encodeURIComponent(result.id)}`)}
        />

        {entries.length > 0 && (
          <Card
            title={`Recently viewed · ${entries.length}`}
            actions={
              <button
                type="button"
                onClick={clear}
                className="text-text-dim hover:text-text text-[11px]"
              >
                Clear
              </button>
            }
          >
            <ul className="m-0 flex flex-col p-0">
              {entries.map((entry, i) => {
                const meta = getEntityTypeMeta(entry.type);
                return (
                  <li
                    key={entry.id}
                    className={i > 0 ? 'border-border border-t' : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => router.push(`/incidents/${encodeURIComponent(entry.id)}`)}
                      className="hover:bg-panel-2 flex w-full items-center gap-3 px-2 py-2 text-left text-[13px]"
                    >
                      <span
                        aria-hidden
                        className={`grid h-6 w-6 place-items-center rounded-xs text-[12px] ${meta.toneBg} ${meta.toneClass}`}
                      >
                        {meta.glyph}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-text truncate font-medium">{entry.name}</span>
                        <span className="text-text-dim truncate font-mono text-[10px]">
                          {entry.id}
                        </span>
                      </span>
                      <IconGlyph name="caretRight" size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <Card title="How it works">
          <ol className="text-text-muted m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
            <li>1. Search for the affected service by name.</li>
            <li>2. Read the safety verdict, responders, and blast radius.</li>
            <li>3. Page on-call, declare in your incident tool, or jump to Slack — all from the dashboard footer.</li>
            <li>4. Paste the dashboard URL into your incident channel so the next responder lands on the same view.</li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
