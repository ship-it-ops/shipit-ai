// An in-memory KnowledgeConnector for tests across the workspace: the SDK, the
// knowledge store, the api-server scheduler and the worker all drive it.
import type { AuthResult, ConnectorConfig, ConnectorManifest } from '../interface.js';
import type {
  ChangeBatch,
  FetchChangesOptions,
  KnowledgeConnector,
  KnowledgeDocumentInput,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from './types.js';

export interface FixtureSeed {
  containers: SourceContainer[];
  principals?: SourcePrincipal[];
  /** Documents per container external id, in sourceUpdatedAt order. */
  documents: Record<string, KnowledgeDocumentInput[]>;
  /** Documents per fetchChanges batch. Default 50. */
  batchSize?: number;
  /** authenticate() refuses with this message. */
  authError?: string;
  /** fetchChanges throws this for the container. */
  fetchErrors?: Record<string, Error>;
  /** listDocumentIds throws this for the container. */
  listIdErrors?: Record<string, Error>;
  /** listContainers yields the first container, then throws this. */
  listContainersError?: Error;
  /** Batches the reconcile hook yields per container. Absent: no hook. */
  reconcileBatches?: Record<string, ChangeBatch[]>;
}

export interface FixtureKnowledgeConnector extends KnowledgeConnector {
  /** Simulate an upstream deletion. */
  deleteDocument(containerId: string, externalId: string): void;
  /** Simulate an upstream edit or arrival. */
  putDocument(containerId: string, doc: KnowledgeDocumentInput): void;
  readonly calls: { fetchChanges: Array<{ container: string; checkpoint: string | null }> };
}

export function createFixtureKnowledgeConnector(seed: FixtureSeed): FixtureKnowledgeConnector {
  const documents = new Map<string, KnowledgeDocumentInput[]>();
  for (const [container, docs] of Object.entries(seed.documents)) {
    documents.set(container, [...docs]);
  }
  const batchSize = seed.batchSize ?? 50;
  const calls = { fetchChanges: [] as Array<{ container: string; checkpoint: string | null }> };

  const manifest: ConnectorManifest = {
    name: 'fixture',
    version: '0.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: [],
  };

  const connector: FixtureKnowledgeConnector = {
    manifest,
    calls,
    async authenticate(_config: ConnectorConfig): Promise<AuthResult> {
      return seed.authError ? { success: false, error: seed.authError } : { success: true };
    },
    async *listContainers() {
      for (const [i, c] of seed.containers.entries()) {
        if (i === 1 && seed.listContainersError) throw seed.listContainersError;
        yield c;
      }
    },
    async *listPrincipals() {
      for (const p of seed.principals ?? []) yield p;
    },
    async *fetchChanges(
      container: SelectedContainer,
      checkpoint: string | null,
      _options: FetchChangesOptions,
    ) {
      calls.fetchChanges.push({ container: container.externalId, checkpoint });
      const error = seed.fetchErrors?.[container.externalId];
      if (error) throw error;
      const all = documents.get(container.externalId) ?? [];
      // The checkpoint is the sourceUpdatedAt of the last stored document.
      const pending = all.filter((d) => checkpoint === null || d.sourceUpdatedAt > checkpoint);
      for (let i = 0; i < pending.length; i += batchSize) {
        const slice = pending.slice(i, i + batchSize);
        yield {
          documents: slice,
          deletedExternalIds: [],
          checkpoint: slice[slice.length - 1]!.sourceUpdatedAt,
        };
      }
    },
    async *listDocumentIds(container: SelectedContainer) {
      const error = seed.listIdErrors?.[container.externalId];
      if (error) throw error;
      const ids = (documents.get(container.externalId) ?? []).map((d) => d.externalId);
      for (let i = 0; i < ids.length; i += batchSize) yield ids.slice(i, i + batchSize);
    },
    deleteDocument(containerId, externalId) {
      documents.set(
        containerId,
        (documents.get(containerId) ?? []).filter((d) => d.externalId !== externalId),
      );
    },
    putDocument(containerId, doc) {
      const list = (documents.get(containerId) ?? []).filter(
        (d) => d.externalId !== doc.externalId,
      );
      list.push(doc);
      list.sort((a, b) => a.sourceUpdatedAt.localeCompare(b.sourceUpdatedAt));
      documents.set(containerId, list);
    },
  };

  if (seed.reconcileBatches) {
    const batches = seed.reconcileBatches;
    connector.reconcile = async function* (container: SelectedContainer) {
      for (const b of batches[container.externalId] ?? []) yield b;
    };
  }
  return connector;
}
