import type { ResolutionStrategy } from '@/lib/api';

export const RESOLUTION_STRATEGIES: ReadonlyArray<{
  value: ResolutionStrategy;
  label: string;
  description: string;
}> = [
  {
    value: 'MANUAL_OVERRIDE_FIRST',
    label: 'Manual override first',
    description: 'Human claims always win. Best for: tier, lifecycle.',
  },
  {
    value: 'AUTHORITATIVE_ORDER',
    label: 'Authoritative order',
    description: 'Ranked source priority. Best for: owner, language.',
  },
  {
    value: 'HIGHEST_CONFIDENCE',
    label: 'Highest confidence',
    description: 'Highest confidence score wins. Best for: name, description.',
  },
  {
    value: 'LATEST_TIMESTAMP',
    label: 'Latest timestamp',
    description: 'Most recent claim wins. Best for: status, replicas.',
  },
  {
    value: 'MERGE_SET',
    label: 'Merge into set',
    description: 'All values combined into a set. Best for: tags, labels.',
  },
];

export const PROPERTY_TYPES = ['string', 'integer', 'boolean', 'string[]'] as const;
