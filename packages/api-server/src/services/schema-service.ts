import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  parseSchemaFile,
  type SchemaDiff,
  type SchemaSnapshot,
  type SchemaTypeChange,
  type ShipItSchema,
} from '@shipit-ai/shared';
import { stringify as stringifyYaml } from 'yaml';

const HISTORY_LIMIT = 10;

/**
 * Thrown by `updateSchema` when the caller's `ifMatchHash` doesn't match the
 * on-disk content hash — the file changed under them. The route maps this to
 * HTTP 409 with the current server hash in the body so the client can decide
 * how to recover (reload, merge, retry).
 */
export class SchemaVersionConflictError extends Error {
  readonly serverHash: string;
  constructor(serverHash: string) {
    super('Schema was modified by another writer since you read it.');
    this.name = 'SchemaVersionConflictError';
    this.serverHash = serverHash;
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export class SchemaService {
  private schema: ShipItSchema | null = null;
  private schemaPath: string;
  private historyDir: string;
  /**
   * Hex SHA-256 of the YAML content backing `this.schema`. Used as the
   * optimistic-locking token (returned as ETag on GET, required as If-Match
   * on PUT). Kept in memory so we don't re-read the file on every probe.
   */
  private currentHash: string | null = null;

  constructor(schemaPath: string) {
    this.schemaPath = schemaPath;
    // History sits next to the active schema file under `schema-history/`.
    this.historyDir = join(dirname(resolve(schemaPath)), 'schema-history');
  }

  async loadSchema(path?: string): Promise<ShipItSchema> {
    const filePath = path ?? this.schemaPath;
    const content = await readFile(filePath, 'utf-8');
    this.schema = parseSchemaFile(content);
    this.currentHash = sha256(content);
    return this.schema;
  }

  getSchema(): ShipItSchema | null {
    return this.schema;
  }

  /** Current content-hash, or `null` when no schema has been loaded. */
  getHash(): string | null {
    return this.currentHash;
  }

  async updateSchema(
    yamlContent: string,
    actor: string = 'system',
    ifMatchHash?: string,
  ): Promise<ShipItSchema> {
    const validated = parseSchemaFile(yamlContent);
    // Optimistic-locking probe — happens BEFORE parse-side-effects mutate
    // any state. If the caller supplied an If-Match and it doesn't match
    // what's on disk, refuse the write and signal the route.
    if (
      ifMatchHash !== undefined &&
      this.currentHash !== null &&
      ifMatchHash !== this.currentHash
    ) {
      throw new SchemaVersionConflictError(this.currentHash);
    }
    // Snapshot the previous version BEFORE overwriting — that way history
    // captures the state we're moving away from. The newly-applied version is
    // the "current" file and isn't duplicated into history.
    if (this.schema) {
      try {
        const previousYaml = await readFile(this.schemaPath, 'utf-8');
        await this.writeSnapshot(previousYaml, actor);
      } catch {
        // First-time write: there's no previous file to snapshot.
      }
    }
    await writeFile(this.schemaPath, yamlContent, 'utf-8');
    this.schema = validated;
    this.currentHash = sha256(yamlContent);
    return validated;
  }

  validateSchema(yamlContent: string): { valid: boolean; schema?: ShipItSchema; error?: string } {
    try {
      const schema = parseSchemaFile(yamlContent);
      return { valid: true, schema };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }

  /** Returns history newest-first. */
  async getHistory(): Promise<SchemaSnapshot[]> {
    try {
      const entries = await readdir(this.historyDir);
      const snapshots: SchemaSnapshot[] = [];
      for (const file of entries) {
        if (!file.endsWith('.yaml')) continue;
        // File format: schema-<ISO-timestamp>--<actor>.yaml
        const match = file.match(/^schema-(.+?)--(.+?)\.yaml$/);
        if (!match) continue;
        const [, version, actor] = match;
        const s = await stat(join(this.historyDir, file));
        snapshots.push({ version, actor, size: s.size });
      }
      return snapshots.sort((a, b) => b.version.localeCompare(a.version));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async getSnapshot(version: string): Promise<string | null> {
    const history = await this.getHistory();
    const snap = history.find((s) => s.version === version);
    if (!snap) return null;
    const file = `schema-${snap.version}--${snap.actor}.yaml`;
    return readFile(join(this.historyDir, file), 'utf-8');
  }

  async rollbackTo(version: string, actor: string = 'system'): Promise<ShipItSchema> {
    const yaml = await this.getSnapshot(version);
    if (yaml === null) {
      throw new Error(`Snapshot ${version} not found`);
    }
    return this.updateSchema(yaml, `${actor} (rollback to ${version})`);
  }

  diffAgainstCurrent(yamlContent: string): SchemaDiff {
    const next = parseSchemaFile(yamlContent);
    const current = this.schema;
    return diffSchemas(current, next);
  }

  private async writeSnapshot(yaml: string, actor: string): Promise<void> {
    await mkdir(this.historyDir, { recursive: true });
    const version = new Date().toISOString().replace(/[:.]/g, '-');
    const safeActor = actor.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
    const file = join(this.historyDir, `schema-${version}--${safeActor}.yaml`);
    await writeFile(file, yaml, 'utf-8');

    // Prune to last HISTORY_LIMIT entries.
    const history = await this.getHistory();
    if (history.length > HISTORY_LIMIT) {
      for (const old of history.slice(HISTORY_LIMIT)) {
        const oldFile = join(this.historyDir, `schema-${old.version}--${old.actor}.yaml`);
        await unlink(oldFile).catch(() => {});
      }
    }
  }
}

function diffSchemas(prev: ShipItSchema | null, next: ShipItSchema): SchemaDiff {
  const prevNodeNames = new Set(Object.keys(prev?.node_types ?? {}));
  const nextNodeNames = new Set(Object.keys(next.node_types));
  const prevRelNames = new Set(Object.keys(prev?.relationship_types ?? {}));
  const nextRelNames = new Set(Object.keys(next.relationship_types));

  const added = {
    node_types: [...nextNodeNames].filter((n) => !prevNodeNames.has(n)),
    relationship_types: [...nextRelNames].filter((n) => !prevRelNames.has(n)),
  };
  const removed = {
    node_types: [...prevNodeNames].filter((n) => !nextNodeNames.has(n)),
    relationship_types: [...prevRelNames].filter((n) => !nextRelNames.has(n)),
  };

  const changed: SchemaTypeChange[] = [];
  if (prev) {
    for (const name of nextNodeNames) {
      if (!prevNodeNames.has(name)) continue;
      const prevNode = prev.node_types[name];
      const nextNode = next.node_types[name];
      if (!prevNode || !nextNode) continue;
      const propChange = diffTypeProps(prevNode.properties ?? {}, nextNode.properties ?? {});
      const structural_changes = diffNodeStructure(prevNode, nextNode);
      if (propChange || structural_changes.length > 0) {
        changed.push({
          kind: 'node_type',
          name,
          added_properties: propChange?.added_properties ?? [],
          removed_properties: propChange?.removed_properties ?? [],
          changed_properties: propChange?.changed_properties ?? [],
          structural_changes,
        });
      }
    }
    for (const name of nextRelNames) {
      if (!prevRelNames.has(name)) continue;
      const prevRel = prev.relationship_types[name];
      const nextRel = next.relationship_types[name];
      if (!prevRel || !nextRel) continue;
      const propChange = diffTypeProps(prevRel.properties ?? {}, nextRel.properties ?? {});
      const structural_changes = diffRelStructure(prevRel, nextRel);
      if (propChange || structural_changes.length > 0) {
        changed.push({
          kind: 'relationship_type',
          name,
          added_properties: propChange?.added_properties ?? [],
          removed_properties: propChange?.removed_properties ?? [],
          changed_properties: propChange?.changed_properties ?? [],
          structural_changes,
        });
      }
    }
  }

  return { added, removed, changed };
}

function diffTypeProps(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Omit<SchemaTypeChange, 'kind' | 'name' | 'structural_changes'> | null {
  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = new Set(Object.keys(next));
  const added_properties = [...nextKeys].filter((k) => !prevKeys.has(k));
  const removed_properties = [...prevKeys].filter((k) => !nextKeys.has(k));
  const changed_properties: SchemaTypeChange['changed_properties'] = [];

  for (const k of nextKeys) {
    if (!prevKeys.has(k)) continue;
    const p = prev[k] as Record<string, unknown>;
    const n = next[k] as Record<string, unknown>;
    const fields = new Set([...Object.keys(p ?? {}), ...Object.keys(n ?? {})]);
    for (const f of fields) {
      const a = p?.[f];
      const b = n?.[f];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changed_properties.push({ name: k, field: f, before: a, after: b });
      }
    }
  }

  if (
    added_properties.length === 0 &&
    removed_properties.length === 0 &&
    changed_properties.length === 0
  ) {
    return null;
  }
  return { added_properties, removed_properties, changed_properties };
}

// Top-level node-type fields that aren't covered by `diffTypeProps` —
// description text changes don't drive migration impact but unique_key
// changes do (they re-key existing nodes).
function diffNodeStructure(
  prev: ShipItSchema['node_types'][string],
  next: ShipItSchema['node_types'][string],
): SchemaTypeChange['structural_changes'] {
  const out: SchemaTypeChange['structural_changes'] = [];
  if ((prev.description ?? '') !== (next.description ?? '')) {
    out.push({ field: 'description', before: prev.description, after: next.description });
  }
  const prevUk = prev.constraints?.unique_key;
  const nextUk = next.constraints?.unique_key;
  if (prevUk !== nextUk) {
    out.push({ field: 'constraints.unique_key', before: prevUk, after: nextUk });
  }
  return out;
}

// `from` / `to` / `cardinality` changes on a relationship type are
// migration-impacting; existing edges with the old endpoints / cardinality
// would no longer match the new spec.
function diffRelStructure(
  prev: ShipItSchema['relationship_types'][string],
  next: ShipItSchema['relationship_types'][string],
): SchemaTypeChange['structural_changes'] {
  const out: SchemaTypeChange['structural_changes'] = [];
  if (prev.from !== next.from) out.push({ field: 'from', before: prev.from, after: next.from });
  if (prev.to !== next.to) out.push({ field: 'to', before: prev.to, after: next.to });
  if (prev.cardinality !== next.cardinality) {
    out.push({ field: 'cardinality', before: prev.cardinality, after: next.cardinality });
  }
  if ((prev.description ?? '') !== (next.description ?? '')) {
    out.push({ field: 'description', before: prev.description, after: next.description });
  }
  return out;
}

// Exposed for the API route layer.
export { stringifyYaml };
