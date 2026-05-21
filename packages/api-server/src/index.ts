import { dirname, isAbsolute, resolve } from 'node:path';
import { findConfigPaths } from '@shipit-ai/shared';
import { BullMQEventBusClient } from '@shipit-ai/event-bus';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { Neo4jService } from './services/neo4j-service.js';
import { SchemaService } from './services/schema-service.js';
import { ConnectorRegistry } from './services/connector-registry.js';
import { SyncScheduler } from './services/sync-scheduler.js';
import { GitHubAppService } from './services/github-app-service.js';
import { GitHubAppManifestService } from './services/github-app-manifest-service.js';

export { createServer } from './server.js';
export type { CreateServerOptions } from './server.js';
export { ConnectorRegistry, ConnectorVersionConflictError } from './services/connector-registry.js';
export type {
  ConnectorRunner,
  SyncRuntimeStatus,
  SyncRuntimeState,
} from './services/connector-registry.js';
export { SyncScheduler } from './services/sync-scheduler.js';
export { GitHubAppService, GitHubAppVersionConflictError } from './services/github-app-service.js';
export type { GitHubAppStatus } from './services/github-app-service.js';
export { GitHubAppManifestService } from './services/github-app-manifest-service.js';
export type {
  ManifestServiceOptions,
  ConversionResult,
} from './services/github-app-manifest-service.js';
export { SchemaService } from './services/schema-service.js';
export { Neo4jService } from './services/neo4j-service.js';
export type { GraphStats, NeighborhoodResult } from './services/neo4j-service.js';

async function main() {
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
  const connectorRegistry = new ConnectorRegistry({
    localConfigPath: localPath,
    initial: config.connectors.instances,
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
  });

  // Wire the BullMQ-backed scheduler if we have Redis. Per-connector App
  // overrides mean the scheduler can still run useful jobs even when the
  // global App is empty (each connector brings its own credentials). We
  // start the scheduler as long as Redis is reachable and let per-job
  // resolution surface APP_NOT_CONFIGURED for connectors that lack both
  // global and override credentials.
  const gh = config.connectors.github.app;
  const hasAnyGitHubConfig =
    (gh.id && gh.privateKeyPath) ||
    config.connectors.instances.some(
      (c) => c.type === 'github' && c.app?.id && c.app?.privateKeyPath,
    );
  let scheduler: SyncScheduler | null = null;
  if (hasAnyGitHubConfig && config.backend.redis.url) {
    try {
      const eventBus = new BullMQEventBusClient({ redisUrl: config.backend.redis.url });
      scheduler = new SyncScheduler({
        redisUrl: config.backend.redis.url,
        registry: connectorRegistry,
        eventBus,
        // Pass the live reference, not a snapshot, so a PUT /github/app
        // update via GitHubAppService is visible to the scheduler's next
        // job without a process restart.
        globalApp: gh,
        concurrency: config.connectors.github.rateLimits.maxConcurrentSyncs,
      });
      // Re-attach the registry to the live runner so create/update/delete
      // can drive the scheduler.
      (connectorRegistry as unknown as { runner: SyncScheduler }).runner = scheduler;
      console.log('SyncScheduler attached to ConnectorRegistry');
    } catch (err) {
      // Don't let a broken scheduler take down the API. Operators see a
      // warning in logs; the UI surfaces sync failures separately.
      console.warn(
        `SyncScheduler init failed (continuing with no-op runner): ${(err as Error).message}`,
      );
    }
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
    config,
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
    await neo4jService.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
