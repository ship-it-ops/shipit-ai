import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSchemaFile } from '../schema/parser.js';
import { validateSchemaRelationships } from '../schema/validator.js';
import { DEFAULT_SCHEMA } from '../schema/defaults.js';
import { DEFAULT_OWNERSHIP_REL_TYPES, getOwnershipRelTypes } from '../schema/semantics.js';

describe('parseSchemaFile', () => {
  it('parses the default YAML schema file', () => {
    const yamlPath = resolve(import.meta.dirname, '../../../../config/shipit-schema.yaml');
    const yamlContent = readFileSync(yamlPath, 'utf-8');
    const schema = parseSchemaFile(yamlContent);

    expect(schema.version).toBe('1.0');
    expect(schema.mode).toBe('full');
    expect(Object.keys(schema.node_types)).toContain('LogicalService');
    expect(Object.keys(schema.node_types)).toContain('Repository');
    expect(Object.keys(schema.node_types)).toContain('Deployment');
    expect(Object.keys(schema.relationship_types)).toContain('IMPLEMENTED_BY');
    expect(Object.keys(schema.relationship_types)).toContain('DEPLOYED_AS');
  });

  it('parses a minimal valid schema', () => {
    const yaml = `
version: "1.0"
mode: full
node_types:
  Service:
    description: "A simple service"
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
relationship_types:
  DEPENDS_ON:
    from: Service
    to: Service
    cardinality: "N:M"
`;
    const schema = parseSchemaFile(yaml);
    expect(schema.node_types['Service']).toBeDefined();
    expect(schema.relationship_types['DEPENDS_ON']).toBeDefined();
  });

  it('rejects invalid resolution strategy', () => {
    const yaml = `
version: "1.0"
mode: full
node_types:
  Service:
    description: "A service"
    properties:
      name:
        type: string
        resolution_strategy: INVALID_STRATEGY
relationship_types: {}
`;
    expect(() => parseSchemaFile(yaml)).toThrow();
  });

  it('rejects missing required fields', () => {
    const yaml = `
version: "1.0"
node_types: {}
relationship_types: {}
`;
    expect(() => parseSchemaFile(yaml)).toThrow();
  });
});

describe('validateSchemaRelationships', () => {
  it('returns no errors for default schema', () => {
    const errors = validateSchemaRelationships(DEFAULT_SCHEMA);
    expect(errors).toEqual([]);
  });

  it('detects missing from label', () => {
    const errors = validateSchemaRelationships({
      version: '1.0',
      mode: 'full',
      node_types: {
        Repository: {
          description: 'A repo',
          properties: {
            name: {
              type: 'string',
              required: true,
              resolution_strategy: 'HIGHEST_CONFIDENCE',
            },
          },
        },
      },
      relationship_types: {
        IMPLEMENTED_BY: {
          from: 'NonExistent',
          to: 'Repository',
          cardinality: '1:N',
        },
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'from' label 'NonExistent'");
  });

  it('accepts and parses optional `semantics: ownership` on a relationship', () => {
    const yaml = `
version: "1.0"
mode: full
node_types:
  Team:
    description: "A team"
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
  LogicalService:
    description: "A service"
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
relationship_types:
  OWNS:
    from: Team
    to: LogicalService
    cardinality: "1:N"
    semantics: ownership
`;
    const schema = parseSchemaFile(yaml);
    expect(schema.relationship_types['OWNS']?.semantics).toBe('ownership');
  });

  it('rejects an unknown semantics value', () => {
    const yaml = `
version: "1.0"
mode: full
node_types:
  Service:
    description: "A service"
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
relationship_types:
  DEPENDS_ON:
    from: Service
    to: Service
    cardinality: "N:M"
    semantics: nonsense
`;
    expect(() => parseSchemaFile(yaml)).toThrow();
  });

  it('detects missing to label', () => {
    const errors = validateSchemaRelationships({
      version: '1.0',
      mode: 'full',
      node_types: {
        LogicalService: {
          description: 'A service',
          properties: {
            name: {
              type: 'string',
              required: true,
              resolution_strategy: 'HIGHEST_CONFIDENCE',
            },
          },
        },
      },
      relationship_types: {
        IMPLEMENTED_BY: {
          from: 'LogicalService',
          to: 'MissingRepo',
          cardinality: '1:N',
        },
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'to' label 'MissingRepo'");
  });
});

describe('getOwnershipRelTypes', () => {
  it('extracts every rel type tagged semantics: ownership', () => {
    const result = getOwnershipRelTypes(DEFAULT_SCHEMA);
    expect(result.has('OWNS')).toBe(true);
    expect(result.has('CODEOWNER_OF')).toBe(true);
  });

  // Regression guard for the bug where MEMBER_OF was treated as ownership.
  // MEMBER_OF is Person → Team — membership, not ownership.
  it('does not mark MEMBER_OF as ownership in the default schema', () => {
    const result = getOwnershipRelTypes(DEFAULT_SCHEMA);
    expect(result.has('MEMBER_OF')).toBe(false);
  });

  it('matches DEFAULT_OWNERSHIP_REL_TYPES for the shipped schema', () => {
    const fromSchema = getOwnershipRelTypes(DEFAULT_SCHEMA);
    expect(new Set(fromSchema)).toEqual(new Set(DEFAULT_OWNERSHIP_REL_TYPES));
  });
});
