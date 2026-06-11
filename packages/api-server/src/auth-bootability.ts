// Boot-time auth invariants, factored out of server.ts so the first-run
// setup flow can EVALUATE them without throwing. Two consumers:
//
//   - createServer() keeps the original throw-on-violation behavior via
//     assertAuthConfigBootable(), so a misconfigured production deployment
//     still fails loud at startup.
//   - index.ts and the /api/setup routes use evaluateAuthBootability() to
//     decide whether the failure is the genuinely-fresh first-run state
//     (→ boot into setup mode) and to report which gates remain.
//
// The gate taxonomy is load-bearing: 'provider' and 'admins' are
// wizard-fixable (the setup wizard mints the GitHub OAuth client and
// captures the admin email), while 'allowedOrigins' and 'sessionSecret'
// are operator-only (chart/Terraform concerns). Setup mode only triggers
// when every missing gate is wizard-fixable — anything else keeps the
// loud AuthConfigError.
import type { Config } from '@shipit-ai/shared';

export type BootGate = 'provider' | 'admins' | 'allowedOrigins' | 'sessionSecret';

export const WIZARD_FIXABLE_GATES: ReadonlySet<BootGate> = new Set<BootGate>([
  'provider',
  'admins',
]);

export interface BootabilityResult {
  bootable: boolean;
  missing: BootGate[];
  messages: string[];
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(`accessControl.auth: ${message}`);
    this.name = 'AuthConfigError';
  }
}

// Boot-time invariants that Zod can't easily express. The messages are
// verbatim from the original server.ts assert so existing runbooks and
// log-based alerts keep matching.
export function evaluateAuthBootability(config: Config, env: NodeJS.ProcessEnv): BootabilityResult {
  const auth = config.accessControl.auth;
  if (!auth.enabled) return { bootable: true, missing: [], messages: [] };

  const missing: BootGate[] = [];
  const messages: string[] = [];

  const oidcEnabled = auth.providers.oidc.enabled;
  const githubEnabled = auth.providers.github.enabled;
  if (!oidcEnabled && !githubEnabled) {
    missing.push('provider');
    messages.push(
      'auth is enabled but no provider is enabled. Set providers.oidc.enabled or providers.github.enabled to true.',
    );
  }

  if (auth.admins.length === 0) {
    missing.push('admins');
    messages.push(
      'auth is enabled but admins[] is empty. Add at least one admin email so the first deployment is usable.',
    );
  }

  // With `credentials: true` CORS (set when auth is enabled), an empty
  // allow-list means every browser request is rejected at the preflight
  // stage — symptomatic of a misconfigured deploy and impossible to
  // diagnose from request logs alone.
  if (config.accessControl.web.allowedOrigins.length === 0) {
    missing.push('allowedOrigins');
    messages.push(
      'auth is enabled but accessControl.web.allowedOrigins is empty. Add at least one origin (e.g. https://app.example.com) so the web-UI can reach the API.',
    );
  }

  const secretEnv = auth.session.signingSecretEnv;
  const secretValue = env[secretEnv];
  if (!secretValue || secretValue.length < 32) {
    missing.push('sessionSecret');
    messages.push(
      `session signing secret env var "${secretEnv}" must be set and at least 32 characters long.`,
    );
  }

  return { bootable: missing.length === 0, missing, messages };
}

// Throwing form — makes a misconfigured production deployment fail loud at
// startup rather than silently accepting requests without auth, or
// rejecting every request because a critical knob is missing.
export function assertAuthConfigBootable(config: Config, env: NodeJS.ProcessEnv): void {
  const result = evaluateAuthBootability(config, env);
  if (!result.bootable) {
    throw new AuthConfigError(result.messages[0]!);
  }
}

// Boot-time derivation: lets a deployment leave setup mode WITHOUT a manual
// config edit. The committed shipit.config.yaml is safe-by-default
// (github.enabled: false, admins: []), and the only durable store in the
// v1 deployment is GSM — so after the setup wizard persists the OAuth
// client and admin email there, the next boot derives the enablement from
// what hydration put in the env:
//
//   - providers.github.enabled flips to true when both OAuth client id and
//     secret are present (GSM-backed stores only — file mode keeps the
//     committed defaults so local misconfiguration still fails loud).
//   - admins[] fills from SHIPIT_AUTH_ADMINS (CSV) when the config left it
//     empty. Allowed for both store kinds: the env var is exclusively ours,
//     which makes local testing of the enforced path possible.
//
// Mutates the config IN PLACE — config.connectors.github.app is a live
// reference the scheduler aliases (docs/agent/patterns/
// live-reference-for-hot-reload.md); cloning the tree here would freeze it.
export interface DerivedAuthConfig {
  derivedGithubProvider: boolean;
  derivedAdmins: boolean;
}

export function applyDerivedAuthConfig(
  config: Config,
  env: NodeJS.ProcessEnv,
  secretStoreKind: 'file' | 'gsm',
): DerivedAuthConfig {
  const auth = config.accessControl.auth;
  const result: DerivedAuthConfig = { derivedGithubProvider: false, derivedAdmins: false };

  if (
    secretStoreKind === 'gsm' &&
    !auth.providers.github.enabled &&
    env.GITHUB_OAUTH_CLIENT_ID &&
    env.GITHUB_OAUTH_CLIENT_SECRET
  ) {
    auth.providers.github.enabled = true;
    // The committed config substitutes clientId from
    // ${GITHUB_OAUTH_CLIENT_ID:-}; backfill covers configs without the
    // placeholder (and the fresh loadConfig() inside /api/setup/complete,
    // which runs after the exchange set the env vars in-process).
    if (!auth.providers.github.clientId) {
      auth.providers.github.clientId = env.GITHUB_OAUTH_CLIENT_ID;
    }
    result.derivedGithubProvider = true;
  }

  if (auth.admins.length === 0 && env.SHIPIT_AUTH_ADMINS) {
    const admins = env.SHIPIT_AUTH_ADMINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (admins.length > 0) {
      auth.admins = admins;
      result.derivedAdmins = true;
    }
  }

  return result;
}
