// Builds the exportable config: the raw base + local YAML files merged
// (the SAME deepMerge loadConfig uses), WITHOUT ${ENV} substitution —
// placeholders survive into the export so the operator can commit it as
// the chart's seed shipit.config.yaml and env injection keeps working on
// the next deploy. This is the durability story for everything that is
// config rather than credential: connector instances, scope, App
// id/key-path wiring, OIDC identifiers. Credentials live in GSM.
//
// Scrubbed on the way out (fail-closed hygiene):
//   - connectors.github.app.webhookSecret (secrets are env-only by ADR)
//   - connectors.instances[*].lastRuns (runtime history; lives in Redis)
//   - backend.mcp.apiKeySecret (literal secret value — the shipped config
//     even tells operators to set it in the local file)
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { deepMerge } from '@shipit-ai/shared';

export interface ConfigExportServiceOptions {
  basePath: string;
  localPath: string;
}

export class ConfigExportService {
  constructor(private paths: ConfigExportServiceOptions) {}

  buildExport(now: Date = new Date()): string {
    const base = this.readRaw(this.paths.basePath) ?? {};
    const local = this.readRaw(this.paths.localPath);
    const merged = (local ? deepMerge(base, local) : base) as Record<string, unknown>;
    this.scrub(merged);
    const header =
      `# Exported from a running ShipIt-AI instance on ${now.toISOString()}.\n` +
      `# Commit this as the deployment's seed shipit.config.yaml (infra repo chart)\n` +
      `# so the next deploy resumes from this configuration. Secrets are NOT in\n` +
      `# this file — they live in Secret Manager / env.\n`;
    return header + stringifyYaml(merged);
  }

  private readRaw(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    return (parseYaml(readFileSync(path, 'utf-8')) ?? {}) as Record<string, unknown>;
  }

  private scrub(merged: Record<string, unknown>): void {
    const mcp = (merged.backend as Record<string, unknown> | undefined)?.mcp as
      | Record<string, unknown>
      | undefined;
    if (mcp) delete mcp.apiKeySecret;
    const connectors = merged.connectors as Record<string, unknown> | undefined;
    const app = (connectors?.github as Record<string, unknown> | undefined)?.app as
      | Record<string, unknown>
      | undefined;
    if (app) delete app.webhookSecret;
    const instances = connectors?.instances;
    if (Array.isArray(instances)) {
      for (const instance of instances) {
        if (instance && typeof instance === 'object') {
          delete (instance as Record<string, unknown>).lastRuns;
        }
      }
    }
  }
}
