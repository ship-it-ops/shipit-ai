// First-run setup flow backing the /api/setup routes. Holds no state of
// its own — every gate is computed from the env + a fresh config load, so
// the manifest exchange (which sets GITHUB_OAUTH_CLIENT_* in-process) and
// setAdminEmail() are immediately visible to status() and complete().
import { loadConfig, type Config } from '@shipit-ai/shared';
import {
  applyDerivedAuthConfig,
  evaluateAuthBootability,
  type BootGate,
} from '../auth-bootability.js';
import type { SecretStore } from '../secrets/types.js';

export interface SetupGates {
  oauthClientPresent: boolean;
  adminConfigured: boolean;
  sessionSecretPresent: boolean;
  allowedOriginsConfigured: boolean;
}

export interface SetupStatus {
  gates: SetupGates;
  ready: boolean;
}

export type SetupCompleteResult =
  | { ok: true }
  | { ok: false; missing: BootGate[]; messages: string[] };

// Deliberately permissive — the goal is catching typos ("mohamed@" or a
// bare name), not RFC 5322 conformance. The IdP is the real validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SetupService {
  private readonly secretStore: SecretStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly loadFreshConfig: () => Config;
  private readonly exit: (code: number) => void;

  constructor(opts: {
    secretStore: SecretStore;
    env?: NodeJS.ProcessEnv;
    // Injectable for tests; production re-reads the YAML so complete()
    // validates exactly what the next boot will see.
    loadFreshConfig?: () => Config;
    exit?: (code: number) => void;
  }) {
    this.secretStore = opts.secretStore;
    this.env = opts.env ?? process.env;
    this.loadFreshConfig = opts.loadFreshConfig ?? (() => loadConfig());
    this.exit = opts.exit ?? ((code) => process.exit(code));
  }

  status(config: Config): SetupStatus {
    const auth = config.accessControl.auth;
    const sessionSecret = this.env[auth.session.signingSecretEnv];
    const gates: SetupGates = {
      oauthClientPresent: Boolean(
        this.env.GITHUB_OAUTH_CLIENT_ID && this.env.GITHUB_OAUTH_CLIENT_SECRET,
      ),
      adminConfigured:
        Boolean(this.env.SHIPIT_AUTH_ADMINS) || config.accessControl.auth.admins.length > 0,
      sessionSecretPresent: Boolean(sessionSecret && sessionSecret.length >= 32),
      allowedOriginsConfigured: config.accessControl.web.allowedOrigins.length > 0,
    };
    return {
      gates,
      ready:
        gates.oauthClientPresent &&
        gates.adminConfigured &&
        gates.sessionSecretPresent &&
        gates.allowedOriginsConfigured,
    };
  }

  async setAdminEmail(email: string): Promise<void> {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      throw new InvalidAdminEmailError(email);
    }
    // GSM is the durable home (shipit.config.local.yaml is an ephemeral
    // emptyDir in the v1 deployment); the env write makes the value
    // visible to status()/complete() in this process, and the next boot
    // re-hydrates it from the store.
    await this.secretStore.write('auth-admin-emails', trimmed);
    this.env.SHIPIT_AUTH_ADMINS = trimmed;
  }

  // Persist the login OAuth App's client id/secret. "Sign in with GitHub"
  // runs on a classic OAuth App the operator creates by hand (GitHub has
  // no manifest/one-click flow for OAuth Apps); the wizard collects the
  // two values and stores them here. Same durability model as the admin
  // email: GSM is the durable home, the env writes make the values visible
  // to status()/complete() this process, and the next boot re-hydrates.
  async setOAuthClient(clientId: string, clientSecret: string): Promise<void> {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret) {
      throw new InvalidOAuthClientError();
    }
    await this.secretStore.write('github-oauth-client-id', id);
    await this.secretStore.write('github-oauth-client-secret', secret);
    this.env.GITHUB_OAUTH_CLIENT_ID = id;
    this.env.GITHUB_OAUTH_CLIENT_SECRET = secret;
  }

  // Re-validates against a FRESH config load + the derivation overlay —
  // i.e. exactly the decision the next boot will make. Returns the missing
  // gates instead of throwing so the route can 409 with actionable detail.
  async complete(): Promise<SetupCompleteResult> {
    const fresh = this.loadFreshConfig();
    applyDerivedAuthConfig(fresh, this.env, this.secretStore.kind);
    const boot = evaluateAuthBootability(fresh, this.env);
    if (!boot.bootable) {
      return { ok: false, missing: boot.missing, messages: boot.messages };
    }
    // One-way latch: with this version present, shouldEnterSetupMode()
    // never reopens the wizard — a later secret loss on this deployment
    // fails loud instead of exposing an unauthenticated admin surface
    // (PR #59 review SC2). Written BEFORE the ok reply/restart so a crash
    // in between can't leave a completed-but-unlatched deployment.
    // FileSecretStore no-ops this write (dev-only forced mode), which is
    // fine — the latch is only consulted for gsm-kind stores.
    await this.secretStore.write('setup-completed', 'true');
    return { ok: true };
  }

  // Called by the route AFTER the {ok:true} reply is flushed. exit(0) +
  // the Deployment's restartPolicy: Always = the pod comes back up, the
  // derivation overlay sees the persisted secrets, and the server boots
  // into enforced auth.
  scheduleRestart(delayMs = 250): void {
    const timer = setTimeout(() => this.exit(0), delayMs);
    // unref() so a test that never fakes timers can still exit cleanly.
    timer.unref?.();
  }
}

export class InvalidAdminEmailError extends Error {
  constructor(email: string) {
    super(`"${email}" is not a valid email address.`);
    this.name = 'InvalidAdminEmailError';
  }
}

export class InvalidOAuthClientError extends Error {
  constructor() {
    super('Both an OAuth client ID and client secret are required.');
    this.name = 'InvalidOAuthClientError';
  }
}
