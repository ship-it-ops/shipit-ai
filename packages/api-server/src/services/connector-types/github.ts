import { GitHubConnector, GitHubKnowledgeConnector } from '@shipit-ai/connector-github';
import type { ConnectorConfig } from '@shipit-ai/connector-sdk';
import { resolveAppCredentials, type GitHubConnectorConfig } from '@shipit-ai/shared';
import type { BuildContext, BuildResult, ConnectorType, KnowledgeBuildResult } from './types.js';

// knowledge.index.maxDocumentChars when the context does not carry it (tests).
const DEFAULT_MAX_DOCUMENT_CHARS = 400_000;

type SdkConfigResult =
  { ok: true; sdkConfig: ConnectorConfig } | { ok: false; code: string; message: string };

/** The App credentials and scope both facets authenticate with. */
function sdkConfigFor(cfg: GitHubConnectorConfig, ctx: BuildContext): SdkConfigResult {
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
    sdkConfig: {
      id: cfg.id,
      type: 'github',
      credentials: { appId: resolved.id, privateKey, installationId: cfg.installationId },
      scope: { org: cfg.org },
    },
  };
}

export const githubConnectorType: ConnectorType<GitHubConnectorConfig> = {
  type: 'github',
  pollMode: 'incremental',
  // GitHub full syncs are bounded by scope.repos.include/exclude, scope.cappedAt,
  // and the entities.* toggles — a full run is not exhaustive, so unseen nodes
  // are not necessarily gone. Never trigger the absence sweep.
  sweepsAbsent: false,

  async build(cfg, ctx): Promise<BuildResult> {
    const resolved = sdkConfigFor(cfg, ctx);
    if (!resolved.ok) return resolved;
    return { ok: true, connector: new GitHubConnector(), sdkConfig: resolved.sdkConfig };
  },

  knowledgeEnabled: (cfg) => cfg.knowledge.enabled,
  knowledgeHistoryDays: (cfg) => cfg.knowledge.historyDays,

  async buildKnowledge(cfg, ctx): Promise<KnowledgeBuildResult> {
    const resolved = sdkConfigFor(cfg, ctx);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      connector: new GitHubKnowledgeConnector({
        knowledge: cfg.knowledge,
        maxDocumentChars: ctx.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS,
      }),
      sdkConfig: resolved.sdkConfig,
    };
  },
};
