import type {
  MigrationImpact,
  MigrationPreview,
  SchemaDiff,
  ShipItSchema,
} from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';

const SAMPLE_LIMIT = 5;

interface Neo4jInt {
  toNumber?: () => number;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Neo4jInt).toNumber === 'function'
  ) {
    return (value as Required<Neo4jInt>).toNumber();
  }
  return Number(value);
}

/**
 * Given a `SchemaDiff` (against the live schema) and a Neo4j service, compute
 * how many existing nodes / edges each destructive or shape-changing edit
 * would affect. Additions to the schema have zero impact and are skipped.
 *
 * Cypher labels and relationship types interpolate the diff's `target` /
 * relationship name directly because Cypher doesn't parameterise those
 * positions. The names come from a Zod-validated `ShipItSchema`, so any
 * shape we'd reach here has already been constrained to identifier-safe
 * characters; still, we wrap labels in backticks defensively against any
 * names that include hyphens.
 */
export async function buildMigrationPreview(
  diff: SchemaDiff,
  currentSchema: ShipItSchema | null,
  neo4j: Neo4jService | undefined,
): Promise<MigrationPreview> {
  const impacts: MigrationImpact[] = [];

  // Removed node types — count nodes carrying the label.
  for (const label of diff.removed.node_types) {
    impacts.push(await countNodeLabel(neo4j, label, `Removes node type \`${label}\``));
  }

  // Removed relationship types — count edges of that type.
  for (const relName of diff.removed.relationship_types) {
    impacts.push(
      await countRelationshipType(neo4j, relName, `Removes relationship type \`${relName}\``),
    );
  }

  // Changes on existing types.
  for (const change of diff.changed) {
    if (change.kind === 'node_type') {
      // Property removals on a node type — count nodes that currently hold
      // a value for the property, since those values will be dropped.
      for (const prop of change.removed_properties) {
        impacts.push({
          kind: 'remove_property',
          target: change.name,
          property: prop,
          summary: `Removes property \`${prop}\` from \`${change.name}\``,
          ...(await samplePropertyHolders(neo4j, change.name, prop)),
        });
      }

      // Property type / requiredness changes — for v1 we report only when
      // a property newly becomes required (existing nodes without the
      // value would fail validation). Type widenings aren't checked.
      for (const change_ of change.changed_properties) {
        if (change_.field === 'required' && change_.before !== true && change_.after === true) {
          impacts.push({
            kind: 'add_required_property',
            target: change.name,
            property: change_.name,
            summary: `Property \`${change_.name}\` on \`${change.name}\` is now required`,
            ...(await sampleMissingPropertyHolders(neo4j, change.name, change_.name)),
          });
        }
      }

      // Unique-key change rekeys every existing node of the type.
      for (const struct of change.structural_changes) {
        if (struct.field === 'constraints.unique_key' && struct.before !== struct.after) {
          impacts.push({
            kind: 'change_unique_key',
            target: change.name,
            summary: `Unique key on \`${change.name}\` changes from \`${String(struct.before ?? '∅')}\` to \`${String(struct.after ?? '∅')}\``,
            ...(await samplesForLabel(neo4j, change.name)),
          });
        }
      }
    } else if (change.kind === 'relationship_type') {
      // Structural changes on a rel type — every existing edge becomes
      // suspect; the user has to migrate or accept stale shape.
      const structuralFields = new Set(change.structural_changes.map((s) => s.field));
      const structural = ['from', 'to', 'cardinality'].some((f) => structuralFields.has(f));
      if (structural) {
        const desc = describeRelStructural(change.structural_changes, currentSchema, change.name);
        impacts.push({
          kind: 'rel_structural_change',
          target: change.name,
          summary: desc,
          ...(await samplesForRelType(neo4j, change.name)),
        });
      }
    }
  }

  return { impacts, skipped: !neo4j };
}

async function countNodeLabel(
  neo4j: Neo4jService | undefined,
  label: string,
  summary: string,
): Promise<MigrationImpact> {
  if (!neo4j) {
    return { kind: 'remove_node_type', target: label, summary, affected: null, samples: [] };
  }
  const safe = backtick(label);
  const countRows = await neo4j.runQuery(`MATCH (n:${safe}) RETURN count(n) AS c`);
  const sampleRows = await neo4j.runQuery(
    `MATCH (n:${safe}) WHERE n.id IS NOT NULL RETURN n.id AS id LIMIT $limit`,
    { limit: SAMPLE_LIMIT },
  );
  return {
    kind: 'remove_node_type',
    target: label,
    summary,
    affected: toNumber(countRows[0]?.get('c') ?? 0),
    samples: sampleRows.map((r) => String(r.get('id'))),
  };
}

async function countRelationshipType(
  neo4j: Neo4jService | undefined,
  relType: string,
  summary: string,
): Promise<MigrationImpact> {
  if (!neo4j) {
    return {
      kind: 'remove_relationship_type',
      target: relType,
      summary,
      affected: null,
      samples: [],
    };
  }
  const safe = backtick(relType);
  const countRows = await neo4j.runQuery(`MATCH ()-[r:${safe}]->() RETURN count(r) AS c`);
  // Edge identity surfaces as `<sourceId>→<targetId>`; raw rel IDs are
  // Neo4j-internal and meaningless to UI users.
  const sampleRows = await neo4j.runQuery(
    `MATCH (a)-[r:${safe}]->(b)
     WHERE a.id IS NOT NULL AND b.id IS NOT NULL
     RETURN a.id AS sourceId, b.id AS targetId LIMIT $limit`,
    { limit: SAMPLE_LIMIT },
  );
  return {
    kind: 'remove_relationship_type',
    target: relType,
    summary,
    affected: toNumber(countRows[0]?.get('c') ?? 0),
    samples: sampleRows.map((r) => `${r.get('sourceId')} → ${r.get('targetId')}`),
  };
}

async function samplePropertyHolders(
  neo4j: Neo4jService | undefined,
  label: string,
  prop: string,
): Promise<{ affected: number | null; samples: string[] }> {
  if (!neo4j) return { affected: null, samples: [] };
  const safe = backtick(label);
  const safeProp = backtick(prop);
  const countRows = await neo4j.runQuery(
    `MATCH (n:${safe}) WHERE n.${safeProp} IS NOT NULL RETURN count(n) AS c`,
  );
  const sampleRows = await neo4j.runQuery(
    `MATCH (n:${safe}) WHERE n.${safeProp} IS NOT NULL AND n.id IS NOT NULL
     RETURN n.id AS id LIMIT $limit`,
    { limit: SAMPLE_LIMIT },
  );
  return {
    affected: toNumber(countRows[0]?.get('c') ?? 0),
    samples: sampleRows.map((r) => String(r.get('id'))),
  };
}

async function sampleMissingPropertyHolders(
  neo4j: Neo4jService | undefined,
  label: string,
  prop: string,
): Promise<{ affected: number | null; samples: string[] }> {
  if (!neo4j) return { affected: null, samples: [] };
  const safe = backtick(label);
  const safeProp = backtick(prop);
  // "newly required" → flag nodes that don't currently have the value.
  const countRows = await neo4j.runQuery(
    `MATCH (n:${safe}) WHERE n.${safeProp} IS NULL RETURN count(n) AS c`,
  );
  const sampleRows = await neo4j.runQuery(
    `MATCH (n:${safe}) WHERE n.${safeProp} IS NULL AND n.id IS NOT NULL
     RETURN n.id AS id LIMIT $limit`,
    { limit: SAMPLE_LIMIT },
  );
  return {
    affected: toNumber(countRows[0]?.get('c') ?? 0),
    samples: sampleRows.map((r) => String(r.get('id'))),
  };
}

async function samplesForLabel(
  neo4j: Neo4jService | undefined,
  label: string,
): Promise<{ affected: number | null; samples: string[] }> {
  if (!neo4j) return { affected: null, samples: [] };
  const safe = backtick(label);
  const countRows = await neo4j.runQuery(`MATCH (n:${safe}) RETURN count(n) AS c`);
  const sampleRows = await neo4j.runQuery(
    `MATCH (n:${safe}) WHERE n.id IS NOT NULL RETURN n.id AS id LIMIT $limit`,
    { limit: SAMPLE_LIMIT },
  );
  return {
    affected: toNumber(countRows[0]?.get('c') ?? 0),
    samples: sampleRows.map((r) => String(r.get('id'))),
  };
}

async function samplesForRelType(
  neo4j: Neo4jService | undefined,
  relType: string,
): Promise<{ affected: number | null; samples: string[] }> {
  if (!neo4j) return { affected: null, samples: [] };
  const safe = backtick(relType);
  const countRows = await neo4j.runQuery(`MATCH ()-[r:${safe}]->() RETURN count(r) AS c`);
  const sampleRows = await neo4j.runQuery(
    `MATCH (a)-[r:${safe}]->(b)
     WHERE a.id IS NOT NULL AND b.id IS NOT NULL
     RETURN a.id AS sourceId, b.id AS targetId LIMIT $limit`,
    { limit: SAMPLE_LIMIT },
  );
  return {
    affected: toNumber(countRows[0]?.get('c') ?? 0),
    samples: sampleRows.map((r) => `${r.get('sourceId')} → ${r.get('targetId')}`),
  };
}

function describeRelStructural(
  changes: SchemaDiff['changed'][number]['structural_changes'],
  currentSchema: ShipItSchema | null,
  relName: string,
): string {
  void currentSchema; // reserved for richer summaries once we report endpoint names inline
  const parts: string[] = [];
  for (const c of changes) {
    if (c.field === 'from' || c.field === 'to' || c.field === 'cardinality') {
      parts.push(`${c.field}: ${String(c.before)} → ${String(c.after)}`);
    }
  }
  return `Relationship \`${relName}\` shape change — ${parts.join(', ')}`;
}

// Cypher doesn't parameterise label / rel-type positions. The names come
// from a Zod-validated schema, so unsafe characters are already rejected
// upstream; backtick-wrapping covers hyphens and other identifier-edge
// shapes the schema-parser allows.
function backtick(identifier: string): string {
  return '`' + identifier.replace(/`/g, '``') + '`';
}
