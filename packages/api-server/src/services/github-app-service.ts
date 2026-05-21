// Owns the global GitHub App config (id + privateKeyPath) — the values
// that live under `connectors.github.app.*` in shipit.config.local.yaml.
// Webhook secret intentionally stays env-only: it's a real secret and the
// secretlint preset (ADR-017) would block a YAML write that contained
// one.
//
// The service holds a reference to the in-memory app object the API
// server constructed at boot, and the SyncScheduler holds the same
// reference. Mutating fields here propagates to both the probe endpoint
// and the scheduler without restart — same trick `SchemaService` uses for
// the in-memory schema after a PUT.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { AppLike } from '@shipit-ai/shared';

// Mirrors ConnectorVersionConflictError so the route layer can map both
// to HTTP 409. Distinct class so `instanceof` checks remain precise.
export class GitHubAppVersionConflictError extends Error {
  readonly serverHash: string;
  constructor(serverHash: string) {
    super('GitHub App config was modified by another writer since you read it.');
    this.name = 'GitHubAppVersionConflictError';
    this.serverHash = serverHash;
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

interface GitHubAppServiceOptions {
  localConfigPath: string;
  // Live reference, not a copy. Mutating its fields updates the
  // SyncScheduler's `globalApp` and the probe endpoint's read of
  // `config.connectors.github.app` in lockstep.
  appConfig: AppLike;
}

export interface GitHubAppStatus {
  configured: boolean;
  id: string | null;
  privateKeyPath: string | null;
}

export class GitHubAppService {
  private localConfigPath: string;
  private appConfig: AppLike;

  constructor(opts: GitHubAppServiceOptions) {
    this.localConfigPath = opts.localConfigPath;
    this.appConfig = opts.appConfig;
  }

  status(): GitHubAppStatus {
    const id = this.appConfig.id?.trim() || null;
    const privateKeyPath = this.appConfig.privateKeyPath?.trim() || null;
    return {
      configured: Boolean(id && privateKeyPath),
      id,
      privateKeyPath,
    };
  }

  // ETag for optimistic concurrency. Same convention as SchemaService /
  // ConnectorRegistry — hex sha256, returned as a strong validator.
  getHash(): string {
    return sha256(JSON.stringify(this.status()));
  }

  async update(
    input: { id: string; privateKeyPath: string },
    ifMatch: string | undefined,
  ): Promise<GitHubAppStatus> {
    const id = input.id?.trim() ?? '';
    const privateKeyPath = input.privateKeyPath?.trim() ?? '';
    if (!id || !privateKeyPath) {
      throw Object.assign(new Error('Both id and privateKeyPath are required'), {
        statusCode: 400,
      });
    }
    const currentHash = this.getHash();
    if (ifMatch !== undefined && ifMatch !== currentHash) {
      throw new GitHubAppVersionConflictError(currentHash);
    }

    await this.persist({ id, privateKeyPath });

    // Mutate the live config object in place so the scheduler + probe
    // endpoint pick up the new values without a server restart. New
    // probes start using these credentials on the next request.
    this.appConfig.id = id;
    this.appConfig.privateKeyPath = privateKeyPath;
    return this.status();
  }

  // Same parseDocument + atomic-rename pattern the connector registry uses.
  // Survives existing comments and unrelated keys in the local YAML.
  private async persist(values: { id: string; privateKeyPath: string }): Promise<void> {
    const raw = existsSync(this.localConfigPath) ? readFileSync(this.localConfigPath, 'utf-8') : '';
    const doc = raw.trim() ? parseDocument(raw) : parseDocument('');
    doc.setIn(['connectors', 'github', 'app', 'id'], values.id);
    doc.setIn(['connectors', 'github', 'app', 'privateKeyPath'], values.privateKeyPath);
    const next = String(doc);
    const tmp = join(dirname(this.localConfigPath), `.${process.pid}.${Date.now()}.shipit-app.tmp`);
    writeFileSync(tmp, next, 'utf-8');
    renameSync(tmp, this.localConfigPath);
  }
}
