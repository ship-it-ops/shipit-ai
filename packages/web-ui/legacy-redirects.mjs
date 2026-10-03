// Routes that moved when the AI nav group was introduced (2026-10). Kept as
// data in its own module so next.config.mjs and the unit test read one list.
// Next applies redirects before middleware, so an unauthenticated visit to an
// old URL becomes /login?redirect_to=<new path>, and query strings carry over.

/** @type {ReadonlyArray<{ source: string; destination: string; permanent: boolean }>} */
export const LEGACY_REDIRECTS = [
  { source: '/ask', destination: '/ai/ask', permanent: true },
  { source: '/configure/mcp', destination: '/ai/mcp', permanent: true },
  { source: '/admin/agent-activity', destination: '/ai/activity', permanent: true },
  // No /ai index page yet. Temporary on purpose: an overview page may claim /ai later.
  { source: '/ai', destination: '/ai/ask', permanent: false },
];
