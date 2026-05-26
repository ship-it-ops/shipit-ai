'use client';

import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Tabs,
  TabsList,
  Tab,
  TabsContent,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { ThemeToggle } from '@/components/layout/theme-toggle';

export default function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <header>
        <h1 className="text-text text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="text-text-muted text-[13px]">
          Account-wide preferences. Theme is persisted to a cookie and survives reloads.
        </p>
      </header>

      <Tabs defaultValue="appearance" variant="pill">
        <TabsList className="w-fit">
          <Tab value="appearance">Appearance</Tab>
          <Tab value="notifications">Notifications</Tab>
          <Tab value="api-keys">API Keys</Tab>
        </TabsList>

        <TabsContent value="appearance" className="mt-4 flex flex-col gap-4">
          <SettingsRow
            title="Theme"
            description="Dark by default. Saved per browser via the shipit-theme cookie."
            control={<ThemeToggle />}
          />
          <SettingsRow
            title="Density"
            description="Comfortable spacing. Compact density is on the roadmap."
            control={<Badge variant="neutral">Comfortable</Badge>}
          />
          <SettingsRow
            title="Reduced motion"
            description="Honors your system prefers-reduced-motion setting automatically."
            control={<Badge variant="neutral">System</Badge>}
          />
        </TabsContent>

        <TabsContent value="notifications" className="mt-4 flex flex-col gap-4">
          <Card title="Channels">
            <p className="text-text-muted mb-3 text-[12px]">
              Where alerts are delivered. Live wiring lands with the Notifications service.
            </p>
            <div className="flex flex-col gap-2">
              <Checkbox label="In-app" defaultChecked disabled />
              <Checkbox label="Email" defaultChecked disabled />
              <Checkbox label="Slack" disabled />
              <Checkbox label="PagerDuty" disabled />
            </div>
          </Card>
          <Card title="Subscriptions">
            <p className="text-text-muted mb-3 text-[12px]">What you want to be told about.</p>
            <div className="flex flex-col gap-2">
              <Checkbox label="Incidents on services I own" defaultChecked disabled />
              <Checkbox label="Connector sync failures" defaultChecked disabled />
              <Checkbox label="Schema changes" disabled />
              <Checkbox label="High-confidence merge candidates awaiting review" disabled />
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="api-keys" className="mt-4">
          <EmptyState
            tone="accent"
            icon={<IconGlyph name="bolt" size={22} />}
            title="No personal access tokens yet"
            description="Per-user tokens for authenticating AI agents against the MCP server are on the roadmap. Until then, see MCP Access for connection info and the shared-secret option."
            action={
              <Button variant="outline" asChild icon={<IconGlyph name="sparkle" />}>
                <a href="/configure/mcp">Open MCP Access</a>
              </Button>
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SettingsRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-text text-[13px] font-medium">{title}</div>
          <div className="text-text-muted mt-[2px] text-[12px]">{description}</div>
        </div>
        <div className="shrink-0">{control}</div>
      </div>
    </Card>
  );
}
