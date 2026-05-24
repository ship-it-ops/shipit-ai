import { z } from 'zod';

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
// Webhook secret intentionally absent: in P0 all installations share the
// global `GITHUB_WEBHOOK_SECRET`. P1 will add per-App webhook secrets via an
// env-var-name field once the webhook receiver lands and we need it.
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
  // Crontab string, e.g. "*/15 * * * *". Polling fallback for missed webhooks.
  schedule: z.string().default('*/15 * * * *'),
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

// Discriminated union — add new connector kinds here as they're built. The
// `type` literal must be unique per kind so Zod can pick the right schema.
// Exported so the registry can validate single instances without having to
// navigate ZodDefault wrappers from the top-level configSchema.
export const connectorInstanceSchema = z.discriminatedUnion('type', [githubConnectorSchema]);

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
});

const connectorsGithubConfigSchema = z.object({
  app: githubAppConfigSchema.default({
    id: '',
    privateKeyPath: '',
    webhookSecret: '',
    webhookPublicUrl: 'http://localhost:3001/api/webhooks/github',
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

export const configSchema = z.object({
  backend: z.object({
    neo4j: z.object({
      uri: z.string(),
      user: z.string(),
      password: z.string(),
    }),
    redis: z.object({
      url: z.string(),
    }),
    api: z.object({
      port: z.number().int().positive(),
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
      },
      rateLimits: { conditionalRequests: true, maxConcurrentSyncs: 3 },
    },
    instances: [],
  }),
});

export type Config = z.infer<typeof configSchema>;
