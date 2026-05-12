'use client';

import { useRouter } from 'next/navigation';
import { Avatar, Badge, Button, Card } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { CURRENT_USER } from '@/lib/current-user';

export default function ProfilePage() {
  const router = useRouter();
  const user = CURRENT_USER;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar size="xl" name={user.name} />
          <div>
            <h1 className="text-text text-[22px] font-semibold tracking-tight">{user.name}</h1>
            <p className="text-text-muted text-[13px]">{user.email}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="accent">{user.role}</Badge>
              <Badge variant="neutral">{user.team}</Badge>
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          icon={<IconGlyph name="settings" />}
          onClick={() => router.push('/settings')}
        >
          Manage account
        </Button>
      </header>

      <Card title="Basic info">
        <dl className="m-0 flex flex-col gap-3 text-[13px]">
          <Row label="Display name" value={user.name} />
          <Row label="Email" value={user.email} />
          <Row label="Role" value={user.role} />
          <Row label="Team" value={user.team} />
          <Row label="Joined" value={new Date(user.joinedAt).toLocaleDateString()} />
        </dl>
      </Card>

      <Card title="Permissions">
        <p className="text-text-muted m-0 mb-3 text-[12px]">
          Capabilities granted to your role. Maps to RBAC scopes once Access Control lands.
        </p>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {user.capabilities.map((cap) => (
            <li key={cap}>
              <Badge variant="outline" size="sm">
                {cap}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Recent activity">
        <p className="text-text-muted m-0 text-[12px]">
          Tool calls, manual claim overrides, and merge actions you&apos;ve performed will appear
          here once Audit Log is wired up.
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border flex items-baseline justify-between gap-3 border-b border-dashed pb-2 last:border-b-0 last:pb-0">
      <dt className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">{label}</dt>
      <dd className="text-text m-0 truncate">{value}</dd>
    </div>
  );
}
