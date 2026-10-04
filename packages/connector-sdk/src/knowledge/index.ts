export type {
  ChangeBatch,
  ContainerKind,
  ContainerVisibility,
  DocumentKind,
  DocumentSegment,
  DocumentState,
  FetchChangesOptions,
  KnowledgeConnector,
  KnowledgeDocumentInput,
  KnowledgeRunMode,
  KnowledgeRunResult,
  KnowledgeSink,
  PruneOptions,
  RunLimits,
  ReconcileOptions,
  SelectedContainer,
  SourceAcl,
  SourceContainer,
  SourcePrincipal,
} from './types.js';
export { KnowledgeHarness } from './harness.js';
export {
  KnowledgeContainerChanged,
  KnowledgeRunCutShort,
  isContainerChanged,
  isRunCutShort,
} from './errors.js';
export type { KnowledgeHarnessOptions } from './harness.js';
export { createFixtureKnowledgeConnector } from './fixture.js';
export type { FixtureKnowledgeConnector, FixtureSeed } from './fixture.js';
