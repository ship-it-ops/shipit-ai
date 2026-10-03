import { z } from 'zod';

// What an agent may do with a tool. `off` hides the tool from the model,
// `allow` runs it, `ask` holds it for a person.
export const GRANT_POLICIES = ['off', 'allow', 'ask'] as const;
export type GrantPolicy = (typeof GRANT_POLICIES)[number];

export const TOOL_EFFECTS = ['read', 'write', 'delete'] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

const policySchema = z.enum(GRANT_POLICIES);

// Delete can be off or ask-first, never auto-allowed (design decision 14).
const deletePolicySchema = z.enum(['off', 'ask']);

const serviceKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'service keys are lower-case letters, digits and dashes');

// '<service>.<tool>', e.g. 'graph.blast_radius' or 'agent.triage'.
const toolIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9_-]{0,62}$/,
    "tool ids look like '<service>.<tool>'",
  );

const serviceGrantsSchema = z.strictObject({
  read: policySchema.default('off'),
  write: policySchema.default('off'),
  delete: deletePolicySchema.default('off'),
});

export const agentLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1),
  maxTokens: z.number().int().min(1000),
  timeoutSeconds: z.number().int().min(10),
  dailyTokens: z.number().int().min(1000),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

export const agentDefinitionSchema = z.strictObject({
  instructions: z.string().trim().min(1, 'instructions are required').max(50_000),
  model: z.string().min(1, 'a model is required').max(64),
  effort: z.string().min(1).max(20).optional(),
  limits: agentLimitsSchema,
  grants: z
    .strictObject({
      services: z.record(serviceKeySchema, serviceGrantsSchema).default({}),
      tools: z.record(toolIdSchema, policySchema).default({}),
    })
    .default({ services: {}, tools: {} }),
  output: z
    .strictObject({
      schema: z.record(z.string(), z.unknown()).nullable().default(null),
    })
    .default({ schema: null }),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export interface DefinitionIssue {
  /** Dot path into the definition, e.g. 'limits.maxTokens'. */
  path: string;
  code: 'INVALID' | 'UNKNOWN_MODEL' | 'LIMIT_EXCEEDS_CEILING';
  message: string;
}

export type ParseDefinitionResult =
  { ok: true; definition: AgentDefinition } | { ok: false; issues: DefinitionIssue[] };

/** Shape check only. Use `checkDefinitionAgainstPolicy` for instance-specific rules. */
export function parseAgentDefinition(input: unknown): ParseDefinitionResult {
  const result = agentDefinitionSchema.safeParse(input);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: 'INVALID' as const,
      message: issue.message,
    })),
  };
}

export interface DefinitionPolicy {
  /** Keys of the models this instance offers (ai.models[].key). */
  modelKeys: ReadonlyArray<string>;
  /** Instance ceilings (ai.limits). An agent may ask for less, never more. */
  ceilings: AgentLimits;
}

export function checkDefinitionAgainstPolicy(
  definition: AgentDefinition,
  policy: DefinitionPolicy,
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  if (!policy.modelKeys.includes(definition.model)) {
    issues.push({
      path: 'model',
      code: 'UNKNOWN_MODEL',
      message:
        policy.modelKeys.length === 0
          ? `Model "${definition.model}" is not available: this instance has no models configured (ai.models).`
          : `Model "${definition.model}" is not one of: ${policy.modelKeys.join(', ')}.`,
    });
  }
  for (const key of Object.keys(policy.ceilings) as Array<keyof AgentLimits>) {
    if (definition.limits[key] > policy.ceilings[key]) {
      issues.push({
        path: `limits.${key}`,
        code: 'LIMIT_EXCEEDS_CEILING',
        message: `limits.${key} is ${definition.limits[key]}; this instance allows at most ${policy.ceilings[key]}.`,
      });
    }
  }
  return issues;
}

/**
 * The (service, effect) pairs a definition switches on. A tool-level grant is
 * reported as effect 'write', the widest effect a non-delete grant can carry:
 * the tool catalog that knows each tool's real effect lives outside this
 * package, and over-reporting can only make the save-time ceiling stricter.
 */
export function grantedServiceEffects(
  definition: AgentDefinition,
): Array<{ service: string; effect: ToolEffect }> {
  const seen = new Set<string>();
  const out: Array<{ service: string; effect: ToolEffect }> = [];
  const add = (service: string, effect: ToolEffect) => {
    const key = `${service}:${effect}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ service, effect });
  };
  for (const [service, grants] of Object.entries(definition.grants.services)) {
    for (const effect of TOOL_EFFECTS) {
      if (grants[effect] !== 'off') add(service, effect);
    }
  }
  for (const [toolId, policy] of Object.entries(definition.grants.tools)) {
    if (policy !== 'off') add(toolId.split('.')[0]!, 'write');
  }
  return out;
}
