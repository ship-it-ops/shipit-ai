/**
 * Typed, frozen view of the `frontend.*` subtree of shipit.config.yaml.
 *
 * `next.config.mjs` loads the YAML at build time and flattens the frontend
 * subtree into NEXT_PUBLIC_SHIPIT_<DOT_PATH> env vars. Next.js inlines those
 * literal `process.env.NEXT_PUBLIC_*` reads at build time — so the lookups
 * below resolve to plain strings in the bundle.
 *
 * Anything that needs to vary per request (vs per build) doesn't belong here —
 * fetch it from /api instead.
 */

export interface DevUserConfig {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  capabilities: ReadonlyArray<string>;
}

export interface ClientConfig {
  api: {
    url: string;
  };
  devUser: DevUserConfig | null;
  integrations: {
    pagerduty: { subdomain: string | null };
    datadog: { site: string | null };
    github: { org: string | null };
    slack: { workspace: string | null; channelPrefix: string };
    kubernetes: { consoleUrlTemplate: string | null };
  };
}

function str(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function csv(value: string | undefined): ReadonlyArray<string> | null {
  if (!value) return null;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

// Each property reads `process.env.NEXT_PUBLIC_SHIPIT_*` *literally* so the
// Next.js bundler inlines the value. Dynamic lookups like `process.env[k]`
// would NOT be replaced and would resolve to undefined in the browser.
const devUserFirstName = str(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_FIRST_NAME);
const devUserLastName = str(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_LAST_NAME);
const devUserEmail = str(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_EMAIL);
const devUserRole = str(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_ROLE);
const devUserTeam = str(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_TEAM);
const devUserJoinedAt = str(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_JOINED_AT);
const devUserCapabilities = csv(process.env.NEXT_PUBLIC_SHIPIT_DEV_USER_CAPABILITIES);

const devUser: DevUserConfig | null =
  devUserFirstName &&
  devUserLastName &&
  devUserEmail &&
  devUserRole &&
  devUserTeam &&
  devUserJoinedAt &&
  devUserCapabilities
    ? {
        firstName: devUserFirstName,
        lastName: devUserLastName,
        email: devUserEmail,
        role: devUserRole,
        team: devUserTeam,
        joinedAt: devUserJoinedAt,
        capabilities: devUserCapabilities,
      }
    : null;

export const clientConfig: ClientConfig = Object.freeze({
  api: {
    url: str(process.env.NEXT_PUBLIC_SHIPIT_API_URL) ?? 'http://localhost:3001',
  },
  devUser,
  integrations: {
    pagerduty: {
      subdomain: str(process.env.NEXT_PUBLIC_SHIPIT_INTEGRATIONS_PAGERDUTY_SUBDOMAIN),
    },
    datadog: {
      site: str(process.env.NEXT_PUBLIC_SHIPIT_INTEGRATIONS_DATADOG_SITE),
    },
    github: {
      org: str(process.env.NEXT_PUBLIC_SHIPIT_INTEGRATIONS_GITHUB_ORG),
    },
    slack: {
      workspace: str(process.env.NEXT_PUBLIC_SHIPIT_INTEGRATIONS_SLACK_WORKSPACE),
      channelPrefix:
        str(process.env.NEXT_PUBLIC_SHIPIT_INTEGRATIONS_SLACK_CHANNEL_PREFIX) ?? 'team-',
    },
    kubernetes: {
      consoleUrlTemplate: str(
        process.env.NEXT_PUBLIC_SHIPIT_INTEGRATIONS_KUBERNETES_CONSOLE_URL_TEMPLATE,
      ),
    },
  },
});
