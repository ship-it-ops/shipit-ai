// The second connector contract: a KnowledgeConnector produces documents for
// the knowledge layer, never graph entities. Spec:
// docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §Connector contract.
import type { AuthResult, ConnectorConfig, ConnectorManifest } from '../interface.js';

export type ContainerKind = 'channel' | 'space' | 'project' | 'repository';

export type DocumentKind =
  | 'slack_thread'
  | 'slack_channel_day'
  | 'confluence_page'
  | 'jira_issue'
  | 'github_pull_request'
  | 'github_issue'
  | 'github_doc';

export type ContainerVisibility = 'open' | 'restricted' | 'unknown';

export type DocumentState = 'open' | 'closed' | 'merged' | 'resolved' | 'archived';

/** A snapshot of who may read something in the source. Recorded, not enforced, in v1. */
export interface SourceAcl {
  /** True when every member of the source can read it. */
  open: boolean;
  /** Source ids of users and groups with read access, when the API gives them cheaply. */
  principals: string[];
  capturedAt: string;
}

export interface SourceContainer {
  externalId: string;
  kind: ContainerKind;
  name: string;
  url?: string;
  visibility: ContainerVisibility;
  archived: boolean;
  acl?: SourceAcl;
}

/** A container the admin selected, with the sync checkpoint the sink holds for it. */
export interface SelectedContainer extends SourceContainer {
  checkpoint: string | null;
}

export interface SourcePrincipal {
  externalId: string;
  kind: 'user' | 'bot' | 'group' | 'external';
  displayName: string;
  email?: string;
  /** GitHub login, when the source has one. */
  login?: string;
  active: boolean;
}

export interface DocumentSegment {
  /** Stable within the document: a message ts, a comment id, a heading path. */
  key: string;
  headingPath?: string[];
  authorExternalId?: string;
  /** Display name at fetch time; the chunker renders it, the principal table resolves identity. */
  authorName?: string;
  at?: string;
  url?: string;
  text: string;
}

export interface KnowledgeDocumentInput {
  externalId: string;
  kind: DocumentKind;
  title: string;
  url: string;
  segments: DocumentSegment[];
  /** Opaque. Equal to the stored value means the content is unchanged. */
  sourceVersion: string;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  authorExternalId?: string;
  participantExternalIds: string[];
  state?: DocumentState;
  /** Source-specific, typed per kind in @shipit-ai/knowledge (status, labels, links, …). */
  attributes: Record<string, unknown>;
  /** True when the item carries its own restriction. Segments must then be empty. */
  restricted: boolean;
  acl?: SourceAcl;
}

export interface ChangeBatch {
  documents: KnowledgeDocumentInput[];
  deletedExternalIds: string[];
  /**
   * The checkpoint to store once this batch is committed. Opaque to the harness.
   * `null` leaves the stored checkpoint untouched; the harness forces that for
   * batches from the reconcile hook so a rescan never moves the poll cursor.
   */
  checkpoint: string | null;
}

export interface PruneOptions {
  /**
   * When the id listing started (ISO-8601). Documents stored after it were not
   * visible to the listing and are spared; the harness sets it.
   */
  listedAt?: string;
}

export interface FetchChangesOptions {
  /** Backfill horizon in days; 0 means everything. */
  historyDays: number;
}

export interface ReconcileOptions {
  /** How far back a source-specific reconcile looks for edits and deletions. */
  days: number;
}

export interface KnowledgeConnector {
  readonly manifest: ConnectorManifest;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  listContainers(): AsyncIterable<SourceContainer>;
  listPrincipals(): AsyncIterable<SourcePrincipal>;
  /** Changes since the checkpoint, oldest first. A null checkpoint starts the backfill. */
  fetchChanges(
    container: SelectedContainer,
    checkpoint: string | null,
    options: FetchChangesOptions,
  ): AsyncIterable<ChangeBatch>;
  /** Every external id that currently exists in the container, in pages. Drives pruning. */
  listDocumentIds(container: SelectedContainer): AsyncIterable<string[]>;
  /** Source-specific edit and deletion detection beyond listDocumentIds (Slack). */
  reconcile?(container: SelectedContainer, options: ReconcileOptions): AsyncIterable<ChangeBatch>;
}

/** Storage behind the harness. Implemented with Postgres in @shipit-ai/knowledge. */
export interface KnowledgeSink {
  /** Replaces the known container list; containers missing from a COMPLETE list are marked gone. */
  upsertContainers(containers: SourceContainer[]): Promise<void>;
  upsertPrincipals(principals: SourcePrincipal[]): Promise<void>;
  selectedContainers(): Promise<SelectedContainer[]>;
  /** Stores documents, tombstones deletions and saves the checkpoint in ONE transaction. */
  storeBatch(
    container: SelectedContainer,
    batch: ChangeBatch,
  ): Promise<{ changed: number; deleted: number }>;
  /**
   * Tombstones every document in the container whose external id is not listed.
   * An empty listing over a container that has documents prunes nothing: a
   * source answering with nothing is far more often a fault than a mass delete.
   */
  pruneMissing(
    container: SelectedContainer,
    presentIds: string[],
    options?: PruneOptions,
  ): Promise<number>;
}

export type KnowledgeRunMode = 'poll' | 'reconcile';

export interface KnowledgeRunResult {
  status: 'success' | 'partial' | 'failed';
  documentsSynced: number;
  documentsDeleted: number;
  containersProcessed: number;
  errors: string[];
  /** authenticate() refused, or a call answered 401/403. Sticky: the scheduler marks `degraded`. */
  authFailed: boolean;
  /** The time budget ran out before every selected container was visited. */
  budgetExhausted: boolean;
  durationMs: number;
}
