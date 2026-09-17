import { GitHubConnector } from '@shipit-ai/connector-github';
import { resolveAppCredentials, type GitHubConnectorConfig } from '@shipit-ai/shared';
import type { BuildResult, ConnectorType } from './types.js';

export const githubConnectorType: ConnectorType<GitHubConnectorConfig> = {
  type: 'github',
  pollMode: 'incremental',
  // GitHub full syncs are bounded by scope.repos.include/exclude, scope.cappedAt,
  // and the entities.* toggles — a full run is not exhaustive, so unseen nodes
  // are not necessarily gone. Never trigger the absence sweep.
  sweepsAbsent: false,

  async build(cfg, ctx): Promise<BuildResult> {
    // Per-connector override wins over the global App; absence of both surfaces
    // as a structured failure (no auth attempt, no misleading 401 from GitHub).
    const resolved = resolveAppCredentials(cfg, ctx.globalApp);
    if (!resolved.id || !resolved.privateKeyPath) {
      return {
        ok: false,
        code: 'APP_NOT_CONFIGURED',
        message: resolved.overridden
          ? `Connector ${cfg.id} overrides the GitHub App but is missing app.id or app.privateKeyPath.`
          : `No GitHub App configured. Set GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_PATH or set connector.app on each instance.`,
      };
    }
    let privateKey: string;
    try {
      privateKey = ctx.readPrivateKey(resolved.privateKeyPath);
    } catch (err) {
      return {
        ok: false,
        code: 'PRIVATE_KEY_UNREADABLE',
        message: `Cannot read App private key at ${resolved.privateKeyPath}: ${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      connector: new GitHubConnector(),
      sdkConfig: {
        id: cfg.id,
        type: 'github',
        credentials: { appId: resolved.id, privateKey, installationId: cfg.installationId },
        scope: { org: cfg.org },
      },
    };
  },
};
