// Durable store for runtime-created GitHub connectors.
//
// The problem: per-org connectors carry their own App credentials (an `app`
// override + a PEM on disk) AND the connector instance itself only ever lands
// in the ephemeral `shipit.config.local.yaml`. On a pod restart/redeploy both
// the PEM (under `/data/keys`) and the instance are wiped, so per-org
// connectors silently vanish. A real secret (the PEM) can't live in the
// committed config either (git + secretlint), so it must come from a secret
// store at boot.
//
// The fix: mirror the registry's full connector set into a single GSM blob
// keyed by connector id — `{connectorId → {instance, pem?, webhookSecret?}}` —
// on every mutation, and at boot rehydrate BOTH the instances (into the
// registry) and the per-org PEM files (to `keyDir`). The blob is authoritative
// once it exists; committed `connectors.instances` is only a first-run seed.
//
// GSM-only by design: file/local deployments already persist connectors + PEMs
// on the durable local filesystem, so this is a no-op there. Storing the
// (non-secret) instance config alongside the (secret) PEM in one GSM container
// follows the existing `auth-admin-emails` precedent — GSM is the only durable
// store in the v1 deployment; Postgres is the eventual home.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { connectorInstanceSchema } from '@shipit-ai/shared';
import type { SecretStore } from '../secrets/types.js';

const BLOB_VERSION = 1;
// GSM caps a secret version at 64 KiB. A per-org PEM is ~1.7 KiB plus a small
// instance record, so ~25–30 connectors fit. Warn before we get close.
const SIZE_WARN_BYTES = 60 * 1024;

interface BlobRecord {
  instance: ConnectorInstanceConfig;
  // Present only for per-org connectors (those with an `app` override). The
  // file content of `instance.app.privateKeyPath`.
  pem?: string;
  webhookSecret?: string;
}

interface ConnectorAppsBlob {
  version: number;
  connectors: Record<string, BlobRecord>;
}

// Minimal shape the registry depends on, so tests can inject a fake.
export interface ConnectorDurableStore {
  sync(connectors: ConnectorInstanceConfig[]): Promise<void>;
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface ConnectorAppStoreOptions {
  store: SecretStore;
  // Where per-org PEMs live on disk; mirrors GitHubAppManifestService's keyDir
  // (SHIPIT_GITHUB_APP_KEY_DIR, default ~/.shipit/keys).
  keyDir?: string;
  logger?: Logger;
}

export class ConnectorAppStore implements ConnectorDurableStore {
  private readonly store: SecretStore;
  private readonly keyDir: string;
  private readonly logger: Logger;

  constructor(opts: ConnectorAppStoreOptions) {
    this.store = opts.store;
    const raw = (opts.keyDir ?? join(homedir(), '.shipit', 'keys')).trim();
    this.keyDir = isAbsolute(raw) ? raw : resolvePath(raw);
    this.logger = opts.logger ?? console;
  }

  // GSM is the only durable store in v1; local/file deployments persist on the
  // real filesystem already, so there's nothing to mirror.
  private get enabled(): boolean {
    return this.store.kind === 'gsm';
  }

  // Mirror the registry's full connector set into the GSM blob. Reads each
  // per-org connector's PEM (and webhook sidecar) from disk. Best-effort: a
  // GSM failure logs and returns without throwing, because the in-memory +
  // YAML state is still correct — only cross-restart durability degrades.
  async sync(connectors: ConnectorInstanceConfig[]): Promise<void> {
    if (!this.enabled) return;
    try {
      const blob: ConnectorAppsBlob = { version: BLOB_VERSION, connectors: {} };
      for (const c of connectors) {
        // Run history is operational state owned by the run store, never the
        // durable config blob.
        const { lastRuns: _ignored, ...instance } = c;
        const record: BlobRecord = { instance: instance as ConnectorInstanceConfig };
        const keyPath = c.app?.privateKeyPath;
        if (c.app?.id && keyPath) {
          const pemPath = join(this.keyDir, basename(keyPath));
          if (existsSync(pemPath)) {
            record.pem = readFileSync(pemPath, 'utf-8');
          }
          const secretPath = join(this.keyDir, `github-app-${c.app.id}.webhook-secret`);
          if (existsSync(secretPath)) {
            const s = readFileSync(secretPath, 'utf-8').trim();
            if (s) record.webhookSecret = s;
          }
        }
        blob.connectors[c.id] = record;
      }
      const json = JSON.stringify(blob);
      const bytes = Buffer.byteLength(json, 'utf-8');
      if (bytes > SIZE_WARN_BYTES) {
        this.logger.warn(
          { bytes, connectors: connectors.length },
          'connector-apps blob is approaching the 64KB GSM version cap',
        );
      }
      await this.store.write('connector-apps', json);
    } catch (err) {
      this.logger.error(
        { err },
        'connector-app-store: failed to persist connector-apps blob (durability degraded)',
      );
    }
  }

  // Write (or rotate) a per-App webhook secret. Persists the sidecar
  // <keyDir>/github-app-<appId>.webhook-secret (mode 0600, trailing newline so
  // it matches what loadAndMaterialize writes and resolveWebhookSecret trims),
  // then re-syncs the GSM blob so the new secret survives a pod restart.
  //
  // The sidecar write is the durable source of truth on disk (file mode + the
  // hot-path resolveWebhookSecret read both rely on it); sync() folds it into
  // the connector-apps blob for gsm deployments and no-ops in file mode.
  async setWebhookSecret(
    appId: string,
    secret: string,
    connectors: ConnectorInstanceConfig[],
  ): Promise<void> {
    mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const secretPath = join(this.keyDir, `github-app-${appId}.webhook-secret`);
    writeFileSync(secretPath, secret + '\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(secretPath, 0o600);
    await this.sync(connectors);
  }

  // Read the blob, materialize per-org PEM + webhook sidecar files to keyDir,
  // and return the connector instances. Returns `null` when there is no blob
  // (first run / file mode / missing GSM container) so the caller can fall
  // back to the committed config; an empty array means the blob exists but
  // holds no connectors (authoritative — don't resurrect from committed).
  async loadAndMaterialize(): Promise<ConnectorInstanceConfig[] | null> {
    if (!this.enabled) return null;
    let raw: string | null;
    try {
      raw = await this.store.read('connector-apps');
    } catch (err) {
      this.logger.error({ err }, 'connector-app-store: failed to read connector-apps blob');
      return null;
    }
    if (!raw) return null;
    let blob: ConnectorAppsBlob;
    try {
      blob = JSON.parse(raw) as ConnectorAppsBlob;
    } catch (err) {
      this.logger.error({ err }, 'connector-app-store: connector-apps blob is corrupt JSON');
      return null;
    }
    if (!blob || typeof blob !== 'object' || !blob.connectors) return [];

    mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const instances: ConnectorInstanceConfig[] = [];
    for (const [id, record] of Object.entries(blob.connectors)) {
      // Re-validate against the live schema so a stale/corrupt entry can't
      // crash boot — skip anything that no longer parses.
      const parsed = connectorInstanceSchema.safeParse({ ...record.instance, lastRuns: [] });
      if (!parsed.success) {
        this.logger.warn(
          { id, issues: parsed.error.issues },
          'skipping malformed connector record',
        );
        continue;
      }
      const inst = parsed.data;
      if (record.pem && inst.app?.id && inst.app?.privateKeyPath) {
        const pemPath = join(this.keyDir, basename(inst.app.privateKeyPath));
        writeFileSync(pemPath, record.pem, { encoding: 'utf-8', mode: 0o600 });
        chmodSync(pemPath, 0o600);
        if (record.webhookSecret) {
          const secretPath = join(this.keyDir, `github-app-${inst.app.id}.webhook-secret`);
          writeFileSync(secretPath, record.webhookSecret + '\n', {
            encoding: 'utf-8',
            mode: 0o600,
          });
          chmodSync(secretPath, 0o600);
        }
      }
      instances.push(inst);
    }
    return instances;
  }
}
