// packages/connectors/github/src/knowledge/index.ts
export {
  GitHubKnowledgeConnector,
  NOTE_ISSUES_PERMISSION,
  NOTE_RATE_LIMITED,
  NOTE_TREE_TRUNCATED,
  clientFromOctokit,
} from './connector.js';
export type {
  ConnectResult,
  GitHubKnowledgeClient,
  GitHubKnowledgeConnectorOptions,
} from './connector.js';
