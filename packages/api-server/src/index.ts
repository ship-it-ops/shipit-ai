import { dirname, isAbsolute, resolve } from 'node:path';
import { Redis } from 'ioredis';
import { findConfigPaths } from '@shipit-ai/shared';
import { BullMQEventBusClient } from '@shipit-ai/event-bus';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { Neo4jService } from './services/neo4j-service.js';
import { SchemaService } from './services/schema-service.js';
import { ConnectorRegistry } from './services/connector-registry.js';
import {
  InMemoryConnectorRunStore,
  RedisConnectorRunStore,
  type ConnectorRunStore,
} from './services/connector-run-store.js';
import { SyncScheduler } from './services/sync-scheduler.js';
import { GitHubAppService } from './services/github-app-service.js';
import { GitHubAppManifestService } from './services/github-app-manifest-service.js';
import { OidcSettingsService } from './services/auth/oidc-settings-service.js';
import { hydrateFromStore, makeSecretStore } from './secrets/index.js';

export { createServer } from './server.js';
export type { CreateServerOptions } from './server.js';
export { ConnectorRegistry, ConnectorVersionConflictError } from './services/connector-registry.js';
export type {
  ConnectorRunner,
  SyncRuntimeStatus,
  SyncRuntimeState,
} from './services/connector-registry.js';
export {
  InMemoryConnectorRunStore,
  RedisConnectorRunStore,
} from './services/connector-run-store.js';
export type { ConnectorRunStore } from './services/connector-run-store.js';
export { SyncScheduler } from './services/sync-scheduler.js';
export { GitHubAppService, GitHubAppVersionConflictError } from './services/github-app-service.js';
export type { GitHubAppStatus } from './services/github-app-service.js';
export { GitHubAppManifestService } from './services/github-app-manifest-service.js';
export type {
  ManifestServiceOptions,
  ConversionResult,
} from './services/github-app-manifest-service.js';
export { OidcSettingsService } from './services/auth/oidc-settings-service.js';
export type {
  OidcSettingsInput,
  OidcSettingsServiceOptions,
} from './services/auth/oidc-settings-service.js';
export { SchemaService } from './services/schema-service.js';
export { Neo4jService } from './services/neo4j-service.js';
export type { GraphStats, NeighborhoodResult } from './services/neo4j-service.js';
export {
  makeSecretStore,
  hydrateFromStore,
  FileSecretStore,
  GsmSecretStore,
  SecretWriteForbiddenError,
} from './secrets/index.js';
export type { SecretStore, LogicalSecret } from './secrets/index.js';

async function main() {
  // Secret store + hydration MUST run before loadConfig(): in gsm mode
  // hydration populates the env vars (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH,
  // OAuth/OIDC secrets) that the chart-seeded config's ${ENV} placeholders
  // reference. In file mode (default) this is a no-op.
  const secretStore = makeSecretStore();
  const hydration = await hydrateFromStore(secretStore);
  if (hydration.hydrated.length > 0) {
    console.log(
      `Hydrated ${hydration.hydrated.length} secret(s) from GSM: ${hydration.hydrated.join(', ')}` +
        (hydration.pemPath ? ` (PEM at ${hydration.pemPath})` : ''),
    );
  } else if (secretStore.kind === 'gsm') {
    console.log(
      'GSM secret store active; no secrets present yet (first run — use the onboarding wizard).',
    );
  }

  const config = loadConfig();
  const { neo4j, schema, api } = config.backend;

  // Relative paths inside `shipit.config.yaml` should be relative to the
  // config file's directory, not the process cwd. Turbo runs the api-server
  // with cwd = `packages/api-server/`, so `./config/shipit-schema.yaml`
  // would otherwise miss the file that lives at the repo root.
  const configDir = dirname(findConfigPaths().basePath);
  const schemaPath = isAbsolute(schema.path) ? schema.path : resolve(configDir, schema.path);

  const neo4jService = new Neo4jService(neo4j.uri, neo4j.user, neo4j.password);
  const schemaService = new SchemaService(schemaPath);

  // Locate the local config file so the registry can write connector edits
  // back. Falls back to the sibling shipit.config.local.yaml of whatever
  // base config we loaded.
  const { localPath } = findConfigPaths();

  // Run history is operational state, not configuration — it lives in
  // Redis (capped LIST per connector) instead of being re-serialized into
  // shipit.config.local.yaml on every poll. The registry accepts an
  // in-memory fallback so the api-server still boots cleanly when Redis
  // is unreachable; in that mode the /runs endpoint just shows whatever
  // accumulated since process start, and operators see the same Redis
  // warning the scheduler logs.
  let runStoreRedis: Redis | null = null;
  let runStore: ConnectorRunStore;
  if (config.backend.redis.url) {
    runStoreRedis = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
    runStore = new RedisConnectorRunStore(runStoreRedis);
    console.log('ConnectorRunStore using Redis at', config.backend.redis.url);
  } else {
    runStore = new InMemoryConnectorRunStore();
    console.warn(
      'No Redis URL configured — connector run history will not persist across restarts.',
    );
  }

  const connectorRegistry = new ConnectorRegistry({
    localConfigPath: localPath,
    initial: config.connectors.instances,
    runStore,
  });

  // GitHubAppService holds a live reference to the same object the
  // scheduler will receive as `globalApp`, so a PUT to /github/app
  // propagates without a server restart.
  const githubAppService = new GitHubAppService({
    localConfigPath: localPath,
    appConfig: config.connectors.github.app,
  });

  // Manifest service handles the "Create App from template" flow.
  // Template lives in the repo at config/github-app-manifest.json;
  // the manifest endpoint substitutes hook/redirect URLs at request
  // time so each instance points at its own ingress.
  const manifestTemplatePath = resolve(configDir, 'config/github-app-manifest.json');
  const githubAppManifestService = new GitHubAppManifestService({
    templatePath: manifestTemplatePath,
    appService: githubAppService,
    // Local-dev default; container deploys override.
    keyDir: process.env.SHIPIT_GITHUB_APP_KEY_DIR,
    secretStore,
  });

  // OIDC settings service: persists client secret via SecretStore (GSM in
  // prod) and public identifiers (issuerUrl, clientId) to
  // shipit.config.local.yaml. Lives alongside the manifest service since
  // both write to the same local config file.
  const oidcSettingsService = new OidcSettingsService({
    localConfigPath: localPath,
    authConfig: config.accessControl.auth,
    secretStore,
  });

  // Wire the BullMQ-backed scheduler whenever Redis is reachable.
  //
  // Earlier versions of this block gated scheduler attachment on having
  // an App configured at boot (`GITHUB_APP_ID` + key path). That created
  // a silent footgun: users who configured the App at runtime via the
  // manifest flow would end up with the registry's default NoopRunner
  // still attached. Their `triggerSync` calls returned an idle status
  // without running anything; the card showed "disconnected" forever.
  //
  // The scheduler's constructor doesn't read keys upfront — it resolves
  // App credentials per job via `resolveAppCredentials(connector, this.globalApp)`,
  // and `globalApp` is a live reference so a later `PUT /github/app`
  // updates the value the scheduler sees on the next job. Safe to attach
  // eagerly: jobs that fire before any App is configured record a
  // friendly APP_NOT_CONFIGURED error and the user sees the actual
  // diagnostic rather than a phantom "disconnected" state.
  // LIVE REFERENCE — must stay aliased to the same object the
  // GitHubAppService mutates on PUT /github/app. The scheduler reads
  // `globalApp.id` / `globalApp.privateKeyPath` on every job, so a write
  // from the wizard or manifest flow propagates without restart. Two
  // footguns that silently break this:
  //   - Spreading `{...config.connectors.github.app}` here would copy the
  //     object and freeze the scheduler at boot-time values.
  //   - `Object.freeze(config.connectors.github.app)` anywhere in the
  //     pipeline would make GitHubAppService.update()'s in-place mutation
  //     throw silently (strict mode) or no-op (sloppy).
  // See docs/agent/patterns/live-reference-for-hot-reload.md and ADR
  // `per-org-github-app-override` for the broader pattern.
  const gh = config.connectors.github.app;
  let scheduler: SyncScheduler | null = null;
  if (config.backend.redis.url) {
    try {
      const eventBus = new BullMQEventBusClient({ redisUrl: config.backend.redis.url });
      scheduler = new SyncScheduler({
        redisUrl: config.backend.redis.url,
        registry: connectorRegistry,
        eventBus,
        // Live reference, not a snapshot — see live-reference-for-hot-reload
        // in docs/agent/patterns/.
        globalApp: gh,
        concurrency: config.connectors.github.rateLimits.maxConcurrentSyncs,
      });
      // Replace the registry's NoopRunner with the live scheduler so
      // future create/update/delete drives BullMQ jobs.
      connectorRegistry.setRunner(scheduler);
      console.log('SyncScheduler attached to ConnectorRegistry');
    } catch (err) {
      // Don't let a broken scheduler take down the API. Operators see a
      // warning in logs; the UI surfaces sync failures separately.
      console.warn(
        `SyncScheduler init failed (continuing with no-op runner): ${(err as Error).message}`,
      );
    }
  } else {
    console.warn(
      'No Redis URL configured — connectors will accept CRUD writes but syncs will not run. Set backend.redis.url to enable.',
    );
  }

  try {
    await schemaService.loadSchema();
  } catch (err) {
    // The previous swallow-and-warn was silent enough that an ENOENT (the
    // common cause in dev) presented as "schema editor is broken" with no
    // log signal beyond a single line at boot. Include the resolved path
    // and the underlying error so the next person debugging this can act.
    console.warn(
      `Could not load schema from ${schemaPath} (cwd=${process.cwd()}, configDir=${configDir}): ${(err as Error).message}. Starting with no schema.`,
    );
  }

  const server = await createServer({
    logger: true,
    neo4jService,
    schemaService,
    connectorRegistry,
    githubAppService,
    githubAppManifestService,
    secretStore,
    oidcSettingsService,
    config,
    // The Redis client used by the session store reuses the run-store
    // connection when present so a single deployment doesn't open two
    // ioredis instances for sibling concerns. When auth is disabled
    // (the default), the session store is never registered so the absence
    // of a Redis URL stays a soft warning rather than a hard boot failure.
    redis: runStoreRedis ?? undefined,
  });

  // Start any pre-configured connectors after the server is constructed so
  // the runner attaches once the rest of the wiring (event bus, etc.) is in
  // place. Tests typically skip this entirely.
  await connectorRegistry.startRunner();

  try {
    await server.listen({ port: api.port, host: '0.0.0.0' });
    console.log(`ShipIt-AI API server listening on port ${api.port}`);
  } catch (err) {
    server.log.error(err);
    await neo4jService.close();
    process.exit(1);
  }

  const shutdown = async () => {
    await server.close();
    if (scheduler) await scheduler.close();
    if (runStoreRedis) runStoreRedis.disconnect();
    await neo4jService.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
