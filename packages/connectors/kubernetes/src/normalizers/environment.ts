import type { KubernetesMappingConfig } from '@shipit-ai/shared';

export type EnvironmentSource = 'label' | 'namespace-label' | 'namespace-rule' | 'default';

export interface EnvironmentDerivation {
  environment: string;
  derivedFrom: EnvironmentSource;
  confidence: number;
}

export const ENVIRONMENT_TYPES = ['development', 'staging', 'production'] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

const CONFIDENCE: Record<EnvironmentSource, number> = {
  label: 0.95,
  'namespace-label': 0.95,
  'namespace-rule': 0.8,
  default: 0.6,
};

function readLabel(labels: Record<string, string>, key: string): string | undefined {
  const direct = labels[key]?.trim();
  if (direct) return direct;
  if (key !== 'env') {
    const alias = labels['env']?.trim();
    if (alias) return alias;
  }
  return undefined;
}

/**
 * Spec §Environment derivation: workload label → namespace label → namespace-name
 * rule → configured default → null (no Environment node, no RUNS_IN_ENV edge).
 */
export function deriveEnvironment(input: {
  workloadLabels: Record<string, string>;
  namespaceLabels: Record<string, string>;
  namespaceName: string;
  mapping: KubernetesMappingConfig['environment'];
}): EnvironmentDerivation | null {
  const { mapping } = input;
  const fromWorkload = readLabel(input.workloadLabels, mapping.label);
  if (fromWorkload)
    return { environment: fromWorkload, derivedFrom: 'label', confidence: CONFIDENCE.label };
  const fromNamespace = readLabel(input.namespaceLabels, mapping.label);
  if (fromNamespace) {
    return {
      environment: fromNamespace,
      derivedFrom: 'namespace-label',
      confidence: CONFIDENCE['namespace-label'],
    };
  }
  for (const rule of mapping.namespaceRules) {
    if (new RegExp(rule.pattern).test(input.namespaceName)) {
      return {
        environment: rule.environment,
        derivedFrom: 'namespace-rule',
        confidence: CONFIDENCE['namespace-rule'],
      };
    }
  }
  if (mapping.default) {
    return { environment: mapping.default, derivedFrom: 'default', confidence: CONFIDENCE.default };
  }
  return null;
}

/** The schema's `Environment.type` enum; anything else is omitted. */
export function environmentType(name: string): EnvironmentType | undefined {
  const lower = name.toLowerCase();
  return (ENVIRONMENT_TYPES as readonly string[]).includes(lower)
    ? (lower as EnvironmentType)
    : undefined;
}
