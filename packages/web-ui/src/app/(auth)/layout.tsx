// Standalone shell for unauthenticated surfaces (login, future
// /forbidden, /session-expired, etc.). Intentionally bare — no sidebar,
// no header, no command palette. The root layout still wraps this in
// <Providers> so React Query, theme, and the auth-redirect listener
// remain available; the listener short-circuits while we're on /login
// so a stray 401 from inside the sign-in flow doesn't loop.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Subtle branded backdrop. Pure CSS so it works in light + dark
          without an extra asset. The radial gradient is keyed off the
          surface/accent tokens via the theme cascade in globals.css. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 800px 600px at 50% -10%, color-mix(in oklab, var(--color-accent) 18%, transparent), transparent 70%), radial-gradient(ellipse 600px 400px at 50% 110%, color-mix(in oklab, var(--color-accent) 10%, transparent), transparent 70%)',
        }}
      />
      <div className="relative flex min-h-screen flex-col items-center justify-center px-6 py-12">
        {children}
      </div>
    </div>
  );
}
