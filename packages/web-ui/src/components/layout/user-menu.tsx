'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  MenuItem,
  MenuSeparator,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useCurrentUser } from '@/lib/current-user';
import { clientConfig } from '@/lib/client-config';

export function UserMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useCurrentUser();

  async function handleSignOut() {
    // POST /api/auth/logout destroys the Redis session + clears the
    // cookie. We then drop the cached principal so the next read goes
    // back through /api/auth/me — which 401s, triggers the auth-required
    // event, and the layout routes to /login. Auth-disabled deployments
    // ignore the request silently; the dev-fallback principal will just
    // reappear on the next fetch.
    try {
      await fetch(`${clientConfig.api.url}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Network failure here just means the cookie outlives the request —
      // not worth a toast. Push to /login regardless so the user isn't
      // stuck in a half-signed-out state.
    }
    queryClient.removeQueries({ queryKey: ['auth', 'me'] });
    router.push('/login');
  }

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
        <MenuItem icon={<IconGlyph name="power" />} onSelect={handleSignOut}>
          Sign out
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
