'use client';

import { useRouter } from 'next/navigation';
import {
  Avatar,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  MenuItem,
  MenuSeparator,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { CURRENT_USER } from '@/lib/current-user';

export function UserMenu() {
  const router = useRouter();
  const user = CURRENT_USER;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open user menu"
          className="focus-visible:ring-accent-dim ring-offset-panel data-[state=open]:ring-accent rounded-full ring-offset-2 transition-[box-shadow] duration-150 outline-none focus-visible:ring-[3px] data-[state=open]:ring-2"
        >
          <Avatar size="md" name={user.name} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="px-2 pt-2 pb-1">
          <div className="text-text text-[12px] font-medium">{user.name}</div>
          <div className="text-text-dim text-[11px]">{user.email}</div>
        </div>
        <MenuSeparator />
        <MenuItem icon={<IconGlyph name="person" />} onSelect={() => router.push('/profile')}>
          View profile
        </MenuItem>
        <MenuItem icon={<IconGlyph name="settings" />} onSelect={() => router.push('/settings')}>
          Settings
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<IconGlyph name="power" />}
          onSelect={() => {
            // TODO: wire to auth sign-out when auth lands.
            console.info('[mock] sign out');
          }}
        >
          Sign out
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
