'use client';

import { Switch, useTheme } from '@ship-it-ui/ui';
import { setThemeCookie } from '@/lib/theme-cookie';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isLight = theme === 'light';

  const handleChange = (next: boolean) => {
    const value = next ? 'light' : 'dark';
    setTheme(value);
    setThemeCookie(value);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="text-text-dim font-mono text-[11px]">
        {isLight ? '☀' : '☾'}
      </span>
      <Switch
        size="sm"
        checked={isLight}
        onCheckedChange={handleChange}
        aria-label="Toggle light theme"
      />
    </span>
  );
}
