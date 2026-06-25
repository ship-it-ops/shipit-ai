// Logical secret taxonomy for the SecretStore abstraction. The GSM
// container names are the Terraform-managed names from the infra repo
// (Ship-It-Ops/shipit-ai-infra, terraform/modules/secret-manager) —
// hard-mapped here per the Q1 contract decision, overridable per secret
// via SHIPIT_GSM_SECRET_<LOGICAL_NAME> for emergencies. The app NEVER
// creates containers, only adds versions to existing ones.
//
// Bootstrap secrets (neo4j-aura-password, session-secret) are
// deliberately NOT writable: the pod's GCP service account has no
// addVersion grant on them, and we fail closed client-side before IAM
// would deny it. See docs/superpowers/specs/2026-06-09-gsm-secret-store-design.md.

export type LogicalSecret =
  | 'github-app-private-key'
  | 'github-webhook-secret'
  | 'github-oauth-client-secret'
  | 'oidc-client-secret'
  | 'github-app-id'
  | 'github-oauth-client-id'
  | 'auth-admin-emails'
  | 'auth-allow-list-emails'
  | 'setup-completed'
  // Durable home for runtime-created connectors that don't live in the
  // committed config: a single JSON blob of {connectorId → {instance, pem,
  // webhookSecret}}. Written wholesale on connector mutations and rehydrated
  // (instances + PEM files) at boot. See ConnectorAppStore.
  | 'connector-apps'
  // Server-held fine-grained PAT (issues:write) used to file issues from the
  // in-app "Report a problem" widget. Read-only at runtime (never app-written),
  // consumed via FEEDBACK_GITHUB_TOKEN.
  | 'github-feedback-token'
  | 'neo4j-aura-password'
  | 'session-secret';

export const GSM_CONTAINER_DEFAULTS: Record<LogicalSecret, string> = {
  'github-app-private-key': 'shipit-github-app-private-key',
  'github-webhook-secret': 'shipit-github-webhook-secret',
  'github-oauth-client-secret': 'shipit-github-oauth-client-secret',
  'oidc-client-secret': 'shipit-oidc-client-secret',
  'github-app-id': 'shipit-github-app-id',
  'github-oauth-client-id': 'shipit-github-oauth-client-id',
  'auth-admin-emails': 'shipit-auth-admin-emails',
  'auth-allow-list-emails': 'shipit-auth-allow-list-emails',
  'setup-completed': 'shipit-setup-completed',
  'connector-apps': 'shipit-connector-apps',
  'github-feedback-token': 'shipit-github-feedback-token',
  'neo4j-aura-password': 'shipit-neo4j-aura-password',
  'session-secret': 'shipit-session-secret',
};

// Which env var each logical secret is consumed through. The PEM has no
// entry — it is consumed as a file via GITHUB_APP_PRIVATE_KEY_PATH, which
// the boot hydration step sets after materializing the PEM from GSM.
// setup-completed has none either: it is the one-way "this deployment
// finished first-run setup" latch, read directly from the store at boot
// (never hydrated, never consumed via env).
export const ENV_VAR_FOR: Partial<Record<LogicalSecret, string>> = {
  'github-webhook-secret': 'GITHUB_WEBHOOK_SECRET',
  'github-oauth-client-secret': 'GITHUB_OAUTH_CLIENT_SECRET',
  'oidc-client-secret': 'OIDC_CLIENT_SECRET',
  'github-app-id': 'GITHUB_APP_ID',
  'github-oauth-client-id': 'GITHUB_OAUTH_CLIENT_ID',
  // Not a secret in the classical sense — GSM is simply the only durable
  // store in the v1 deployment (shipit.config.local.yaml is an ephemeral
  // emptyDir; see docs/agent/decisions/api-server-config-persistence-strategy.md).
  // CSV of admin emails captured by the first-run setup wizard.
  'auth-admin-emails': 'SHIPIT_AUTH_ADMINS',
  // CSV of emails allowed to sign in (login guardrail). App-writable via the
  // admin Portal Settings allow-list editor (SettingsService.setAllowlist),
  // now that the infra addVersion grant is in place (see WRITABLE_SECRETS).
  'auth-allow-list-emails': 'SHIPIT_AUTH_ALLOWLIST',
  'neo4j-aura-password': 'NEO4J_PASSWORD',
  'session-secret': 'SHIPIT_SESSION_SECRET',
  // Read-only: the feedback widget's issue-filing PAT.
  'github-feedback-token': 'FEEDBACK_GITHUB_TOKEN',
};

export const WRITABLE_SECRETS: ReadonlySet<LogicalSecret> = new Set<LogicalSecret>([
  'github-app-private-key',
  'github-webhook-secret',
  'github-oauth-client-secret',
  'oidc-client-secret',
  'github-app-id',
  'github-oauth-client-id',
  'auth-admin-emails',
  // Login allow-list. Now app-writable: the infra grant (addVersion on
  // shipit-auth-allow-list-emails for the pod's GCP service account) is in
  // place, enabling the admin Portal Settings allow-list editor.
  'auth-allow-list-emails',
  'setup-completed',
  'connector-apps',
]);

export class SecretWriteForbiddenError extends Error {
  constructor(name: LogicalSecret) {
    super(
      `Refusing to write bootstrap secret "${name}" — bootstrap secrets are operator-managed ` +
        `(see scripts/bootstrap-secrets.md in the infra repo).`,
    );
    this.name = 'SecretWriteForbiddenError';
  }
}

export function assertWritable(name: LogicalSecret): void {
  if (!WRITABLE_SECRETS.has(name)) throw new SecretWriteForbiddenError(name);
}

// SHIPIT_GSM_SECRET_GITHUB_APP_PRIVATE_KEY etc. — logical name upper-snaked.
export function gsmContainerFor(name: LogicalSecret, env: NodeJS.ProcessEnv): string {
  const override = env[`SHIPIT_GSM_SECRET_${name.toUpperCase().replace(/-/g, '_')}`];
  return override && override.trim() ? override.trim() : GSM_CONTAINER_DEFAULTS[name];
}

export interface SecretStore {
  // 'file' keeps today's local behavior; 'gsm' is the GKE deployment.
  readonly kind: 'file' | 'gsm';
  // null = no value exists yet (first run) — never an error.
  read(name: LogicalSecret): Promise<string | null>;
  // Throws SecretWriteForbiddenError for bootstrap secrets.
  // Callers must pass a non-empty value; writing an empty string is undefined behavior.
  write(name: LogicalSecret, value: string): Promise<void>;
}
