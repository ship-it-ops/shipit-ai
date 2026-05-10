export const THEME_COOKIE_NAME = 'shipit-theme';

export type StoredTheme = 'light' | 'dark';

export function setThemeCookie(value: StoredTheme): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${THEME_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function readThemeFromCookieHeader(cookieHeader: string | undefined): StoredTheme {
  if (!cookieHeader) return 'dark';
  const match = cookieHeader
    .split(/;\s*/)
    .find((part) => part.startsWith(`${THEME_COOKIE_NAME}=`));
  if (!match) return 'dark';
  const value = match.slice(THEME_COOKIE_NAME.length + 1);
  return value === 'light' ? 'light' : 'dark';
}
