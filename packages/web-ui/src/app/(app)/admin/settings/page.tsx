'use client';

// Admin-only settings hub (sidebar Admin group). Holds INSTANCE/ADMIN-level
// configuration only — GitHub webhooks, login & access (OAuth client, admin
// emails, allow-list), and instance IdP/config export. Per-user preferences
// live separately on /settings (the user menu). Every backing endpoint is
// server-gated (403); this page also gates the UI and fails closed while
// identity loads.
import { Card, Tabs, TabsList, Tab, TabsContent } from '@ship-it-ui/ui';
import { WebhooksTab } from '@/components/settings/webhooks-tab';
import { AccessTab } from '@/components/settings/access-tab';
import { InstanceTab } from '@/components/settings/instance-tab';
import { useCurrentUserQuery } from '@/lib/current-user';

export default function AdminSettingsPage() {
  const { data, isLoading } = useCurrentUserQuery();

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <p className="text-text-dim m-0 py-6 text-center text-[12px]">Loading…</p>
        </Card>
      </div>
    );
  }

  if (data?.role !== 'admin') {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <p className="text-err m-0 py-6 text-center text-[12px]" role="alert">
            Admin access required.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <header>
        <h1 className="text-text text-[22px] font-semibold tracking-tight">Admin Settings</h1>
        <p className="text-text-muted text-[13px]">
          Instance-level configuration. Only admins can view or change these.
        </p>
      </header>

      <Tabs defaultValue="webhooks" variant="pill">
        <TabsList className="w-fit">
          <Tab value="webhooks">GitHub Webhooks</Tab>
          <Tab value="access">Login &amp; Access</Tab>
          <Tab value="instance">Instance</Tab>
        </TabsList>

        <TabsContent value="webhooks" className="mt-4">
          <WebhooksTab />
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <AccessTab />
        </TabsContent>
        <TabsContent value="instance" className="mt-4">
          <InstanceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
