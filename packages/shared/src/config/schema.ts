import { z } from 'zod';

// ── Secrets registry ───────────────────────────────────────────────────────
// The canonical list of every logical secret the platform knows about.
// This tuple is the single source of truth: Task 3 mirrors it into
// shipit.config.yaml, and the superRefine below enforces coverage.
export const LOGICAL_SECRETS = [
  'neo4j-aura-password',
  'session-secret',
  'github-app-private-key',
  'github-app-id',
  'github-webhook-secret',
  'github-oauth-client-id',
  'github-oauth-client-secret',
  'oidc-client-secret',
  'auth-admin-emails',
  'auth-allow-list-emails',
  'github-feedback-token',
  'setup-completed',
  'connector-apps',
] as const;

const secretEntrySchema = z.object({
  gsmContainer: z.string().min(1),
  consume: z.enum(['env', 'file', 'store-only']).default('env'),
  env: z.string().optional(),
  filePathEnv: z.string().optional(),
  writable: z.boolean().default(false),
  required: z.boolean().default(false),
});

export const secretsRegistrySchema = z.record(z.string(), secretEntrySchema);
export type SecretEntry = z.infer<typeof secretEntrySchema>;
export type SecretsRegistry = z.infer<typeof secretsRegistrySchema>;

// Structural validation for a 5-field crontab string (minute hour dom month dow).
// Each field is a comma-separated list of: `*`, `*/n` step, `a-b` range,
// `a-b/n` ranged step, or a plain integer. This rejects obvious garbage before
// the string reaches BullMQ (which would otherwise throw at scheduler start);
// it is deliberately permissive about value ranges — not a full semantic check.
const CRON_FIELD = /^(\*|\d+|\d+-\d+)(\/\d+)?(,(\*|\d+|\d+-\d+)(\/\d+)?)*$/;
export function isCrontabShape(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

// ── Connector instance config ──────────────────────────────────────────────
// One entry per configured upstream system (e.g. one GitHub org = one
// instance). Persisted under connectors.instances[] in shipit.config.local.yaml
// and edited via /api/connectors with ETag optimistic concurrency. Discriminated
// by `type` so each connector kind can define its own scope shape without the
// loader having to know about every connector.

const githubScopeSchema = z.object({
  repos: z
    .object({
      include: z.array(z.string()).default(['**']),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: ['**'], exclude: [] }),
  teams: z
    .object({
      include: z.array(z.string()).default(['**']),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: ['**'], exclude: [] }),
  // Initial-add safety cap. Until the user acknowledges, sync only the first
  // `cappedAt` repos. Set null to lift entirely. Acknowledgement flips the
  // bool — the cap value stays so we don't lose the historical default.
  cappedAt: z.number().int().positive().nullable().default(100),
  cappedAcknowledged: z.boolean().default(false),
});

const githubEntitiesSchema = z
  .object({
    repository: z.boolean().default(true),
    team: z.boolean().default(true),
    pipeline: z.boolean().default(true),
    codeowners: z.boolean().default(true),
    // Hardened entity types — added in v1, default off until P1 ships them.
    environment: z.boolean().default(false),
    deployment: z.boolean().default(false),
    branchProtection: z.boolean().default(false),
    workflowRun: z.boolean().default(false),
  })
  .default({
    repository: true,
    team: true,
    pipeline: true,
    codeowners: true,
    environment: false,
    deployment: false,
    branchProtection: false,
    workflowRun: false,
  });

export const lastRunSchema = z.object({
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  // 'success' | 'partial' | 'failed' — broader than ShipIt's internal sync
  // state machine because we persist the *outcome* of a finished run here.
  status: z.enum(['success', 'partial', 'failed']),
  entitiesSynced: z.number().int().nonnegative(),
  errors: z.array(z.string()).default([]),
});

// ── Per-connector App override ────────────────────────────────────────────
// By default a connector inherits the global App from connectors.github.app.*.
// Setting `app` here overrides it for THIS connector only — useful for
// blast-radius isolation (separate Apps for dev/prod orgs) or for serving
// orgs that don't trust a shared App. Either field can be set independently;
// the runner resolves each field individually with the global as fallback.
//
// Webhook secret intentionally absent from this override: a per-org App's
// webhook secret is resolved at receive time from the per-App sidecar
// (github-app-<appId>.webhook-secret, materialized at boot from the
// connector-apps GSM blob), with the global `GITHUB_WEBHOOK_SECRET` used only
// for connectors on the global App. See packages/api-server webhook-resolution.ts
// and routes/webhooks.ts.
const githubConnectorAppOverrideSchema = z
  .object({
    id: z.string().optional(),
    privateKeyPath: z.string().optional(),
  })
  .optional();

const githubConnectorSchema = z.object({
  id: z.string().min(1),
  type: z.literal('github'),
  enabled: z.boolean().default(true),
  name: z.string().min(1),
  // GitHub App installation that backs this connector instance. The App
  // itself is configured once globally under connectors.github.app.*; only the
  // installation id and org name vary per instance — unless `app` below
  // overrides the App identity for this connector specifically.
  installationId: z.string().min(1),
  org: z.string().min(1),
  app: githubConnectorAppOverrideSchema,
  // Crontab string, e.g. "*/30 * * * *". Polling fallback for missed webhooks.
  // 5-field crontab only. The shape check rejects obviously malformed input so
  // a bad string can't reach BullMQ and throw at scheduler start time; it is a
  // structural check, not full semantic cron validation.
  schedule: z.string().default('*/30 * * * *').refine(isCrontabShape, {
    message: 'Invalid cron schedule — expected a 5-field crontab string, e.g. "*/30 * * * *".',
  }),
  scope: githubScopeSchema.default({
    repos: { include: ['**'], exclude: [] },
    teams: { include: ['**'], exclude: [] },
    cappedAt: 100,
    cappedAcknowledged: false,
  }),
  entities: githubEntitiesSchema,
  // Last N runs, newest first. Capped at 20 by the scheduler — older entries
  // are dropped when persisting back to YAML.
  lastRuns: z.array(lastRunSchema).default([]),
});

export type GitHubConnectorConfig = z.infer<typeof githubConnectorSchema>;
export type LastRun = z.infer<typeof lastRunSchema>;

// ── Kubernetes connector instance ─────────────────────────────────────────
// One instance per cluster: `cluster.name` scopes every canonical id the
// connector emits, the way a GitHub org scopes repository ids. Credentials
// NEVER live here — `access` references FILES inside the key dir (written by
// POST /api/connectors/kubernetes/credentials, mirrored into the connector-apps
// GSM blob). Design: docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md

export const KUBERNETES_WORKLOAD_KINDS = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
] as const;
export type KubernetesWorkloadKind = (typeof KUBERNETES_WORKLOAD_KINDS)[number];

const K8S_CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const kubernetesAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('in-cluster') }),
  z.object({
    mode: z.literal('kubeconfig'),
    kubeconfigPath: z.string().min(1),
    context: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal('token'),
    server: z.string().regex(HTTPS_URL, 'server must be an https:// URL'),
    tokenPath: z.string().min(1),
    caDataPath: z.string().min(1).optional(),
  }),
]);

const kubernetesScopeSchema = z
  .object({
    namespaces: z
      .object({
        include: z.array(z.string().min(1)).default(['*']),
        exclude: z
          .array(z.string().min(1))
          .default(['kube-system', 'kube-public', 'kube-node-lease']),
      })
      .prefault({}),
    kinds: z
      .array(z.enum(KUBERNETES_WORKLOAD_KINDS))
      .min(1)
      .default([...KUBERNETES_WORKLOAD_KINDS]),
  })
  .prefault({});

const kubernetesMappingSchema = z
  .object({
    service: z
      .object({
        nameFrom: z
          .array(z.enum(['part-of', 'name', 'workload']))
          .min(1)
          .default(['part-of', 'name', 'workload']),
        includeComponent: z.boolean().default(false),
      })
      .prefault({}),
    environment: z
      .object({
        label: z.string().min(1).default('environment'),
        namespaceRules: z
          .array(
            z.object({
              pattern: z
                .string()
                .min(1)
                .refine(isValidRegex, { message: 'pattern must be a valid regular expression' }),
              environment: z.string().min(1),
            }),
          )
          .default([
            { pattern: '^(prod|production)', environment: 'production' },
            { pattern: '^(stag|staging)', environment: 'staging' },
            { pattern: '^(dev|development)', environment: 'development' },
          ]),
        default: z.string().min(1).nullable().default(null),
      })
      .prefault({}),
    ownership: z.object({ teamLabel: z.string().min(1).default('team') }).prefault({}),
    repoLink: z
      .object({
        annotation: z.string().min(1).default('shipit.ai/github-repo'),
        githubOrg: z.string().min(1).nullable().default(null),
        nameMatch: z.boolean().default(true),
      })
      .prefault({}),
  })
  .prefault({});

const kubernetesConnectorSchema = z.object({
  id: z.string().min(1),
  type: z.literal('kubernetes'),
  enabled: z.boolean().default(true),
  name: z.string().min(1),
  schedule: z.string().default('*/5 * * * *').refine(isCrontabShape, {
    message: 'Invalid cron schedule — expected a 5-field crontab string, e.g. "*/5 * * * *".',
  }),
  cluster: z.object({
    name: z
      .string()
      .regex(
        K8S_CLUSTER_NAME,
        'cluster.name must be lowercase DNS-label style ([a-z0-9-], max 63 chars)',
      ),
  }),
  access: kubernetesAccessSchema,
  scope: kubernetesScopeSchema,
  mapping: kubernetesMappingSchema,
  lastRuns: z.array(lastRunSchema).default([]),
});

export type KubernetesConnectorConfig = z.infer<typeof kubernetesConnectorSchema>;
export type KubernetesMappingConfig = KubernetesConnectorConfig['mapping'];
export type KubernetesScopeConfig = KubernetesConnectorConfig['scope'];
export type KubernetesAccessConfig = KubernetesConnectorConfig['access'];

// Discriminated union — add new connector kinds here as they're built. The
// `type` literal must be unique per kind so Zod can pick the right schema.
// Exported so the registry can validate single instances without having to
// navigate ZodDefault wrappers from the top-level configSchema.
export const connectorInstanceSchema = z.discriminatedUnion('type', [
  githubConnectorSchema,
  kubernetesConnectorSchema,
]);

export type ConnectorInstanceConfig = z.infer<typeof connectorInstanceSchema>;

// ── App-credential resolution ─────────────────────────────────────────────
// Single source of truth for "which App identity does this connector use?".
// The scheduler, probe endpoint, and (P1) webhook router all call this
// helper so override semantics can't drift between layers. Returns nulls
// rather than throwing — callers translate the absence into a structured
// error code (APP_NOT_CONFIGURED) so the UI can render an actionable
// message.
export interface ResolvedAppCredentials {
  id: string | null;
  privateKeyPath: string | null;
  // True if any override field on the connector was applied. Surfaced in
  // probe responses + drawer so admins can see at a glance which Apps a
  // connector is using.
  overridden: boolean;
}

export interface AppLike {
  id?: string;
  privateKeyPath?: string;
}

export function resolveAppCredentials(
  connector: { app?: AppLike } | undefined,
  global: AppLike,
): ResolvedAppCredentials {
  const overrideId = connector?.app?.id?.trim();
  const overrideKey = connector?.app?.privateKeyPath?.trim();
  const id = overrideId || global.id || null;
  const privateKeyPath = overrideKey || global.privateKeyPath || null;
  return {
    id: id && id.length > 0 ? id : null,
    privateKeyPath: privateKeyPath && privateKeyPath.length > 0 ? privateKeyPath : null,
    overridden: Boolean(overrideId || overrideKey),
  };
}

// ── Connectors section ────────────────────────────────────────────────────
// Top-level `connectors:` block, distinct from `backend:` (services ShipIt
// runs) and `frontend:` (Next.js client config). Holds:
//   - per-source-type defaults (github, etc.) — auth identity, rate limits
//   - the list of configured connector instances
// Private key paths and webhook secrets are env-only (never serialized
// back); App IDs and webhook URLs are safe to commit.

const githubAppConfigSchema = z.object({
  id: z.string().default(''),
  privateKeyPath: z.string().default(''),
  webhookSecret: z.string().default(''),
  webhookPublicUrl: z.string().default('http://localhost:3001/api/webhooks/github'),
  // Logical secret keys for the GitHub App credentials in the registry.
  idSecret: z.string().default('github-app-id'),
  webhookSecretRef: z.string().default('github-webhook-secret'),
  privateKeySecret: z.string().default('github-app-private-key'),
});

const connectorsGithubConfigSchema = z.object({
  app: githubAppConfigSchema.default({
    id: '',
    privateKeyPath: '',
    webhookSecret: '',
    webhookPublicUrl: 'http://localhost:3001/api/webhooks/github',
    idSecret: 'github-app-id',
    webhookSecretRef: 'github-webhook-secret',
    privateKeySecret: 'github-app-private-key',
  }),
  rateLimits: z
    .object({
      conditionalRequests: z.boolean().default(true),
      maxConcurrentSyncs: z.number().int().positive().default(3),
    })
    .default({ conditionalRequests: true, maxConcurrentSyncs: 3 }),
});

const connectorsSectionSchema = z.object({
  github: connectorsGithubConfigSchema.default({
    app: {
      id: '',
      privateKeyPath: '',
      webhookSecret: '',
      webhookPublicUrl: 'http://localhost:3001/api/webhooks/github',
      idSecret: 'github-app-id',
      webhookSecretRef: 'github-webhook-secret',
      privateKeySecret: 'github-app-private-key',
    },
    rateLimits: { conditionalRequests: true, maxConcurrentSyncs: 3 },
  }),
  // Configured connector instances. Persisted to shipit.config.local.yaml
  // and managed via /api/connectors. Defaults to empty so a fresh checkout
  // boots cleanly.
  instances: z.array(connectorInstanceSchema).default([]),
});

const integrationsSchema = z.object({
  pagerduty: z.object({
    subdomain: z.string().nullable().default(null),
  }),
  datadog: z.object({
    site: z.string().nullable().default(null),
  }),
  github: z.object({
    org: z.string().nullable().default(null),
  }),
  slack: z.object({
    workspace: z.string().nullable().default(null),
    channelPrefix: z.string().default('team-'),
  }),
  kubernetes: z.object({
    consoleUrlTemplate: z.string().nullable().default(null),
  }),
});

const devUserSchema = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    role: z.string(),
    team: z.string(),
    joinedAt: z.string(),
    capabilities: z.array(z.string()),
  })
  .optional();

// ── Access control / authentication ───────────────────────────────────────
// Top-level `accessControl:` block. The `auth.enabled` flag is the master
// switch: when false (local dev default), the api-server synthesizes a
// principal from `frontend.devUser` and skips OIDC entirely.
//
// Production sets `enabled: true`; the boot-time invariant (validated in
// the api-server, not here — Zod can't easily express it) requires at
// least one enabled provider and a non-empty `admins[]`.
//
// Secrets are NEVER stored here. Provider config holds the *registry key*
// (e.g. `clientSecretRef: "oidc-client-secret"`) and the api-server resolves
// it through the boot-hydrated secrets accessor. Same pattern as
// `connectors.github.app.privateKeyPath` — keys and paths are safe to
// commit; the values they point at are not.

// When a provider is disabled the empty-string defaults below are fine —
// the provider never gets instantiated. When enabled, the refines below
// turn missing values into a loud, dotted-path validation error at
// loadConfig() time instead of a surprise at first login attempt.
const oidcProviderSchema = z
  .object({
    enabled: z.boolean().default(false),
    issuerUrl: z.string().default(''),
    clientId: z.string().default(''),
    scopes: z.array(z.string()).default(['openid', 'email', 'profile']),
    emailClaim: z.string().default('email'),
    displayName: z.string().default('OIDC'),
    // Logical secret key for the OIDC client secret in the registry.
    clientSecretRef: z.string().default('oidc-client-secret'),
  })
  .refine((v) => !v.enabled || v.issuerUrl.length > 0, {
    message: 'must be set when oidc.enabled is true',
    path: ['issuerUrl'],
  })
  .refine((v) => !v.enabled || v.clientId.length > 0, {
    message: 'must be set when oidc.enabled is true',
    path: ['clientId'],
  })
  .refine((v) => !v.enabled || v.clientSecretRef.length > 0, {
    message:
      'must name the secrets-registry key holding the client secret when oidc.enabled is true',
    path: ['clientSecretRef'],
  })
  .refine((v) => !v.enabled || v.displayName.length > 0, {
    message: 'must be set when oidc.enabled is true (shown on the login button)',
    path: ['displayName'],
  });

const githubOAuthProviderSchema = z
  .object({
    enabled: z.boolean().default(false),
    clientId: z.string().default(''),
    // Optional GitHub-org allow-list. Empty array = any GitHub user with an
    // account can log in. Distinct from the connector-side `org` config —
    // this gates *web-UI sign-in*, not the data sync.
    allowedOrgs: z.array(z.string()).default([]),
    displayName: z.string().default('GitHub'),
    // Logical secret key for the GitHub OAuth client secret in the registry.
    clientSecretRef: z.string().default('github-oauth-client-secret'),
  })
  .refine((v) => !v.enabled || v.clientId.length > 0, {
    message: 'must be set when github.enabled is true',
    path: ['clientId'],
  })
  .refine((v) => !v.enabled || v.clientSecretRef.length > 0, {
    message:
      'must name the secrets-registry key holding the client secret when github.enabled is true',
    path: ['clientSecretRef'],
  });

const sessionSchema = z.object({
  ttlHours: z.number().int().positive().default(12),
  cookieName: z.string().default('shipit_sid'),
  // `lax` is the right default for first-party web-UI on its own origin.
  // SaaS deployments fronted by a different domain than the api-server
  // need `none` (and `secure: true`).
  sameSite: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Forced to true outside development by the api-server at boot. Kept
  // configurable so a self-hosted operator with TLS-terminating proxies
  // can opt back in.
  secure: z.boolean().default(true),
  // Logical secret key pointing at the session signing secret in the
  // registry. Required (non-empty) at boot when auth.enabled is true.
  secretRef: z.string().default('session-secret'),
});

const accessControlSchema = z.object({
  auth: z
    .object({
      enabled: z.boolean().default(false),
      providers: z
        .object({
          oidc: oidcProviderSchema.default({
            enabled: false,
            issuerUrl: '',
            clientId: '',
            scopes: ['openid', 'email', 'profile'],
            emailClaim: 'email',
            displayName: 'OIDC',
            clientSecretRef: 'oidc-client-secret',
          }),
          github: githubOAuthProviderSchema.default({
            enabled: false,
            clientId: '',
            allowedOrgs: [],
            displayName: 'GitHub',
            clientSecretRef: 'github-oauth-client-secret',
          }),
        })
        .default({
          oidc: {
            enabled: false,
            issuerUrl: '',
            clientId: '',
            scopes: ['openid', 'email', 'profile'],
            emailClaim: 'email',
            displayName: 'OIDC',
            clientSecretRef: 'oidc-client-secret',
          },
          github: {
            enabled: false,
            clientId: '',
            allowedOrgs: [],
            displayName: 'GitHub',
            clientSecretRef: 'github-oauth-client-secret',
          },
        }),
      admins: z.array(z.string()).default([]),
      // Optional sign-in allow-list. Empty = any authenticated user may
      // sign in (and gets the default 'member' role). Non-empty = ONLY
      // listed emails may sign in.
      allowList: z.array(z.string()).default([]),
      session: sessionSchema.default({
        ttlHours: 12,
        cookieName: 'shipit_sid',
        sameSite: 'lax',
        secure: true,
        secretRef: 'session-secret',
      }),
    })
    .default({
      enabled: false,
      providers: {
        oidc: {
          enabled: false,
          issuerUrl: '',
          clientId: '',
          scopes: ['openid', 'email', 'profile'],
          emailClaim: 'email',
          displayName: 'OIDC',
          clientSecretRef: 'oidc-client-secret',
        },
        github: {
          enabled: false,
          clientId: '',
          allowedOrgs: [],
          displayName: 'GitHub',
          clientSecretRef: 'github-oauth-client-secret',
        },
      },
      admins: [],
      allowList: [],
      session: {
        ttlHours: 12,
        cookieName: 'shipit_sid',
        sameSite: 'lax',
        secure: true,
        secretRef: 'session-secret',
      },
    }),
  // CORS allow-list for the web-UI origin(s). When auth is disabled, the
  // api-server falls back to permissive CORS so the existing local-dev
  // flow keeps working. When auth is enabled, this list is enforced and
  // `credentials: 'include'` round-trips require an exact match.
  web: z
    .object({
      allowedOrigins: z.array(z.string()).default(['http://localhost:3000']),
    })
    .default({
      allowedOrigins: ['http://localhost:3000'],
    }),
  // Feature kill-switch for the manual-edit write path (claims v1a). Default
  // ON: any signed-in human (member or admin holds `graph:write`) may author a
  // `manual:<actor>` claim. Flip `enabled: false` to make the manual-write
  // routes 403 with FEATURE_DISABLED — an instant rollback that needs no
  // redeploy, leaving the read paths untouched.
  manualWrite: z
    .object({
      enabled: z.boolean().default(true),
      // Retention window (days) for `GraphEditEvent` audit nodes. Default ON at
      // 90 days: a daily cleanup job DETACH-DELETEs audit events older than
      // `now - auditRetentionDays`, bounding their otherwise-unbounded growth
      // (same incident class as the 2026-06-17/2026-06-22 Redis OOM scars — see
      // docs/agent/plans/manual-edit-write-path.md S6). Set `0` to DISABLE
      // retention and keep every audit event forever. Negative values are
      // rejected at load time.
      auditRetentionDays: z.number().int().nonnegative().default(90),
    })
    .default({
      enabled: true,
      auditRetentionDays: 90,
    }),
});

export type AccessControlConfig = z.infer<typeof accessControlSchema>;
export type AuthConfig = AccessControlConfig['auth'];

// Top-level `feedback:` block — backs the in-app "Report a problem" widget.
// Non-secret values only (committable, like connectors.github.app): the
// issue-filing identity is a server-held fine-grained PAT consumed via the
// FEEDBACK_GITHUB_TOKEN env var (hydrated from GSM), never stored here.
// `enabled` is additionally gated on that token being present at runtime.
const feedbackConfigSchema = z.object({
  // Explicit kill-switch. Defaults true, but the widget is gated at runtime on
  // a target repo AND the FEEDBACK_GITHUB_TOKEN being present, so it stays off
  // until configured. Set false to hard-disable even when those are set. Kept a
  // literal (not env-substituted) because the loader yields strings for ${...}.
  enabled: z.boolean().default(true),
  repo: z
    .object({
      owner: z.string().default(''),
      name: z.string().default(''),
    })
    .default({ owner: '', name: '' }),
  defaultLabels: z.array(z.string()).default(['user-report']),
  // Logical secret key for the fine-grained PAT used to file issues.
  tokenSecret: z.string().default('github-feedback-token'),
});

const baseConfigSchema = z.object({
  // Secrets registry — maps logical secret keys to their GSM container and
  // consumption mode. Defaults include all 13 canonical entries so a config
  // without a `secrets:` block still validates. Task 3 mirrors these values
  // into shipit.config.yaml as the committed baseline.
  secrets: secretsRegistrySchema.default({
    'neo4j-aura-password': {
      gsmContainer: 'shipit-neo4j-aura-password',
      consume: 'env',
      env: 'NEO4J_PASSWORD',
      writable: false,
      required: true,
    },
    'session-secret': {
      gsmContainer: 'shipit-session-secret',
      consume: 'env',
      env: 'SHIPIT_SESSION_SECRET',
      writable: false,
      required: true,
    },
    'github-app-private-key': {
      gsmContainer: 'shipit-github-app-private-key',
      consume: 'file',
      filePathEnv: 'GITHUB_APP_PRIVATE_KEY_PATH',
      writable: true,
      required: false,
    },
    'github-app-id': {
      gsmContainer: 'shipit-github-app-id',
      consume: 'env',
      env: 'GITHUB_APP_ID',
      writable: true,
      required: false,
    },
    'github-webhook-secret': {
      gsmContainer: 'shipit-github-webhook-secret',
      consume: 'env',
      env: 'GITHUB_WEBHOOK_SECRET',
      writable: true,
      required: false,
    },
    'github-oauth-client-id': {
      gsmContainer: 'shipit-github-oauth-client-id',
      consume: 'env',
      env: 'GITHUB_OAUTH_CLIENT_ID',
      writable: true,
      required: false,
    },
    'github-oauth-client-secret': {
      gsmContainer: 'shipit-github-oauth-client-secret',
      consume: 'env',
      env: 'GITHUB_OAUTH_CLIENT_SECRET',
      writable: true,
      required: false,
    },
    'oidc-client-secret': {
      gsmContainer: 'shipit-oidc-client-secret',
      consume: 'env',
      env: 'OIDC_CLIENT_SECRET',
      writable: true,
      required: false,
    },
    'auth-admin-emails': {
      gsmContainer: 'shipit-auth-admin-emails',
      consume: 'env',
      env: 'SHIPIT_AUTH_ADMINS',
      writable: true,
      required: false,
    },
    'auth-allow-list-emails': {
      gsmContainer: 'shipit-auth-allow-list-emails',
      consume: 'env',
      env: 'SHIPIT_AUTH_ALLOWLIST',
      writable: true,
      required: false,
    },
    'github-feedback-token': {
      gsmContainer: 'shipit-github-feedback-token',
      consume: 'env',
      env: 'FEEDBACK_GITHUB_TOKEN',
      writable: false,
      required: false,
    },
    'setup-completed': {
      gsmContainer: 'shipit-setup-completed',
      consume: 'store-only',
      writable: true,
      required: false,
    },
    'connector-apps': {
      gsmContainer: 'shipit-connector-apps',
      consume: 'store-only',
      writable: true,
      required: false,
    },
  }),
  backend: z.object({
    neo4j: z.object({
      uri: z.string(),
      user: z.string(),
      password: z.string(),
      // Logical secret key for the Neo4j password in the registry.
      passwordSecret: z.string().default('neo4j-aura-password'),
    }),
    redis: z.object({
      url: z.string(),
    }),
    api: z.object({
      port: z.number().int().positive(),
      // Honor X-Forwarded-* from a TLS-terminating proxy (Ingress / LB).
      // Required when auth is on behind such a proxy: @fastify/session
      // refuses to set the Secure session cookie when request.protocol
      // reads 'http', which silently breaks login. Also keys rate limits
      // on the real client IP instead of the proxy's.
      trustProxy: z.boolean().default(false),
    }),
    schema: z.object({
      path: z.string(),
    }),
    cypherQuery: z.object({
      timeoutMs: z.number().int().positive(),
      rowLimit: z.number().int().positive(),
    }),
    reconciliation: z.object({
      threshold: z.number().min(0).max(1),
    }),
    mcp: z.object({
      apiKeySecret: z.string().nullable().default(null),
      rateLimits: z.object({
        graphQueryPerDay: z.number().int().positive(),
        rowLimit: z.number().int().positive(),
        hopLimit: z.number().int().positive(),
        queryTimeoutMs: z.number().int().positive(),
      }),
    }),
  }),
  frontend: z.object({
    api: z.object({
      url: z.string(),
    }),
    devUser: devUserSchema,
    integrations: integrationsSchema,
  }),
  // Top-level connectors section — see `connectorsSectionSchema` above.
  // Optional at the root so existing configs without a connectors block
  // still validate; defaults populate the empty github + instances shape.
  connectors: connectorsSectionSchema.default({
    github: {
      app: {
        id: '',
        privateKeyPath: '',
        webhookSecret: '',
        webhookPublicUrl: 'http://localhost:3001/api/webhooks/github',
        idSecret: 'github-app-id',
        webhookSecretRef: 'github-webhook-secret',
        privateKeySecret: 'github-app-private-key',
      },
      rateLimits: { conditionalRequests: true, maxConcurrentSyncs: 3 },
    },
    instances: [],
  }),
  // Top-level accessControl section — see `accessControlSchema` above.
  // Defaulted shape so existing configs without an accessControl block
  // still validate and boot with auth disabled.
  accessControl: accessControlSchema.default({
    auth: {
      enabled: false,
      providers: {
        oidc: {
          enabled: false,
          issuerUrl: '',
          clientId: '',
          scopes: ['openid', 'email', 'profile'],
          emailClaim: 'email',
          displayName: 'OIDC',
          clientSecretRef: 'oidc-client-secret',
        },
        github: {
          enabled: false,
          clientId: '',
          allowedOrgs: [],
          displayName: 'GitHub',
          clientSecretRef: 'github-oauth-client-secret',
        },
      },
      admins: [],
      allowList: [],
      session: {
        ttlHours: 12,
        cookieName: 'shipit_sid',
        sameSite: 'lax',
        secure: true,
        secretRef: 'session-secret',
      },
    },
    web: {
      allowedOrigins: ['http://localhost:3000'],
    },
    manualWrite: {
      enabled: true,
      auditRetentionDays: 90,
    },
  }),
  // In-app feedback widget target. Defaulted (disabled) so existing configs
  // without a feedback block still validate and boot.
  feedback: feedbackConfigSchema.default({
    enabled: true,
    repo: { owner: '', name: '' },
    defaultLabels: ['user-report'],
    tokenSecret: 'github-feedback-token',
  }),
});

// Cross-reference validation: ensure every logical secret has a registry entry
// and every feature secret-ref points to a known key.
export const configSchema = baseConfigSchema.superRefine((cfg, ctx) => {
  for (const key of LOGICAL_SECRETS) {
    if (!cfg.secrets[key]) {
      ctx.addIssue({
        code: 'custom',
        path: ['secrets', key],
        message: `missing registry entry for known secret "${key}"`,
      });
    }
  }
  const refs: Array<[string[], string | undefined]> = [
    [['feedback', 'tokenSecret'], cfg.feedback.tokenSecret],
    [['accessControl', 'auth', 'session', 'secretRef'], cfg.accessControl.auth.session.secretRef],
    [['backend', 'neo4j', 'passwordSecret'], cfg.backend.neo4j.passwordSecret],
    [['connectors', 'github', 'app', 'idSecret'], cfg.connectors.github.app.idSecret],
    [
      ['connectors', 'github', 'app', 'webhookSecretRef'],
      cfg.connectors.github.app.webhookSecretRef,
    ],
    [
      ['connectors', 'github', 'app', 'privateKeySecret'],
      cfg.connectors.github.app.privateKeySecret,
    ],
    [
      ['accessControl', 'auth', 'providers', 'oidc', 'clientSecretRef'],
      cfg.accessControl.auth.providers.oidc.clientSecretRef,
    ],
    [
      ['accessControl', 'auth', 'providers', 'github', 'clientSecretRef'],
      cfg.accessControl.auth.providers.github.clientSecretRef,
    ],
  ];
  for (const [path, ref] of refs) {
    if (ref && !cfg.secrets[ref]) {
      ctx.addIssue({ code: 'custom', path, message: `references unknown secret "${ref}"` });
    }
  }
});

export type Config = z.infer<typeof configSchema>;
