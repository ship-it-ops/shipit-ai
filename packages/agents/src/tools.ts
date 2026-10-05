import { createHash } from 'node:crypto';
import type { AgentDefinition, GrantPolicy, ToolEffect } from './definition.js';
import type { RunWritePolicy } from './run-store.js';

/** One callable tool, described the same way whatever its source. */
export interface ToolDescriptor {
  /** '<service>.<tool>', e.g. 'graph.blast_radius'. */
  id: string;
  service: string;
  effect: ToolEffect;
  description: string;
  /** JSON Schema for the tool's input, as the model sees it. */
  inputSchema: Record<string, unknown>;
  source: 'builtin' | 'connection' | 'agent';
  /** False for a connection tool whose effect no admin has confirmed. */
  effectConfirmed: boolean;
  enabled: boolean;
}

export interface ResolvedTool extends ToolDescriptor {
  policy: Exclude<GrantPolicy, 'off'>;
  /** The name the model sees and calls. */
  modelName: string;
}

const MODEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/**
 * The name a model sees for a tool id. Provider name rules reject dots, so
 * 'graph.blast_radius' becomes 'graph__blast_radius'. An id that would still
 * break the rules (too long, or starting with a digit) gets a short hash prefix,
 * which keeps names distinct and stable across runs.
 */
export function modelToolName(toolId: string): string {
  const plain = toolId.replace('.', '__');
  if (MODEL_NAME.test(plain)) return plain;
  const hash = createHash('sha256').update(toolId).digest('hex').slice(0, 8);
  return `t_${hash}_${plain.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/**
 * The policy a definition gives one tool, after the ceilings. A tool grant beats
 * the service grant for the tool's effect; nothing granted is `off`. Each
 * ceiling can only tighten:
 *   1. a delete is never `allow`;
 *   2. an `always_ask` run asks before any write or delete;
 *   3. a tool whose effect nobody confirmed is treated as a write that asks;
 *   4. a disabled tool is `off`.
 */
export function resolvePolicy(
  definition: AgentDefinition,
  tool: ToolDescriptor,
  writePolicy: RunWritePolicy,
): GrantPolicy {
  if (!tool.enabled) return 'off';
  const effect: ToolEffect = tool.effectConfirmed ? tool.effect : 'write';
  let policy: GrantPolicy =
    definition.grants.tools[tool.id] ?? definition.grants.services[tool.service]?.[effect] ?? 'off';
  if (policy === 'off') return 'off';
  if (!tool.effectConfirmed) return 'ask';
  if (effect === 'delete' && policy === 'allow') policy = 'ask';
  if (writePolicy === 'always_ask' && effect !== 'read' && policy === 'allow') policy = 'ask';
  return policy;
}

/** The tools a run may offer the model, in catalog order, and what was dropped. */
export function resolveTools(
  definition: AgentDefinition,
  catalog: readonly ToolDescriptor[],
  writePolicy: RunWritePolicy,
): { tools: ResolvedTool[]; warnings: string[] } {
  const tools: ResolvedTool[] = [];
  for (const tool of catalog) {
    const policy = resolvePolicy(definition, tool, writePolicy);
    if (policy !== 'off') tools.push({ ...tool, policy, modelName: modelToolName(tool.id) });
  }
  const known = new Set(catalog.map((t) => t.id));
  const warnings = Object.keys(definition.grants.tools)
    .filter((id) => !known.has(id))
    .map((id) => `The grant for ${id} was ignored: no such tool is available.`);
  return { tools, warnings };
}
