export { loadConfig, deepMerge, loadSecretsRegistry } from './loader.js';
export type { LoadConfigOptions } from './loader.js';
export { findConfigPaths } from './find-root.js';
export type { ConfigPaths } from './find-root.js';
export {
  configSchema,
  connectorInstanceSchema,
  resolveAppCredentials,
  LOGICAL_SECRETS,
  secretsRegistrySchema,
  KUBERNETES_WORKLOAD_KINDS,
  KUBERNETES_DEFAULT_MAPPING,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
} from './schema.js';
export type {
  Config,
  ConnectorInstanceConfig,
  GitHubConnectorConfig,
  GitHubKnowledgeConfig,
  LastRun,
  ResolvedAppCredentials,
  AppLike,
  AccessControlConfig,
  AuthConfig,
  AiConfig,
  AiModelConfig,
  KnowledgeConfig,
  SecretEntry,
  SecretsRegistry,
  KubernetesConnectorConfig,
  KubernetesMappingConfig,
  KubernetesScopeConfig,
  KubernetesAccessConfig,
  KubernetesWorkloadKind,
} from './schema.js';
