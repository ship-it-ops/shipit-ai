import { z } from 'zod';
import type { ShipItSchema } from '../types/schema.js';

const resolutionStrategySchema = z.enum([
  'MANUAL_OVERRIDE_FIRST',
  'HIGHEST_CONFIDENCE',
  'AUTHORITATIVE_ORDER',
  'LATEST_TIMESTAMP',
  'MERGE_SET',
]);

const propertyDefSchema = z.object({
  type: z.string(),
  required: z.boolean().optional().default(false),
  resolution_strategy: resolutionStrategySchema,
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const nodeTypeDefSchema = z.object({
  description: z.string(),
  properties: z.record(z.string(), propertyDefSchema),
  constraints: z
    .object({
      unique_key: z.string().optional(),
    })
    .optional(),
});

const relTypeDefSchema = z.object({
  from: z.string(),
  to: z.string(),
  cardinality: z.enum(['1:1', '1:N', 'N:1', 'N:M']),
  properties: z.record(z.string(), propertyDefSchema).optional(),
  description: z.string().optional(),
});

const schemaSchema = z.object({
  version: z.string(),
  mode: z.enum(['full', 'simple']),
  node_types: z.record(z.string(), nodeTypeDefSchema),
  relationship_types: z.record(z.string(), relTypeDefSchema),
  resolution_defaults: z.record(z.string(), resolutionStrategySchema).optional(),
});

export function validateSchema(raw: unknown): ShipItSchema {
  return schemaSchema.parse(raw) as ShipItSchema;
}

export function validateSchemaRelationships(schema: ShipItSchema): string[] {
  const errors: string[] = [];
  const nodeLabels = new Set(Object.keys(schema.node_types));

  for (const [relType, relDef] of Object.entries(schema.relationship_types)) {
    if (!nodeLabels.has(relDef.from)) {
      errors.push(`Relationship ${relType}: 'from' label '${relDef.from}' not found in node_types`);
    }
    if (!nodeLabels.has(relDef.to)) {
      errors.push(`Relationship ${relType}: 'to' label '${relDef.to}' not found in node_types`);
    }
  }

  return errors;
}
