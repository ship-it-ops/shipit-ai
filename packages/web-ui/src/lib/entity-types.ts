'use client';

import { registerEntityTypes } from '@ship-it-ui/shipit';

registerEntityTypes({
  LogicalService: {
    iconName: 'service',
    label: 'Logical service',
    toneClass: 'text-accent',
    toneBg: 'bg-accent-dim',
    colorVar: 'var(--color-accent)',
    badgeVariant: 'accent',
  },
  RuntimeService: {
    iconName: 'server',
    label: 'Runtime service',
    toneClass: 'text-accent-text',
    toneBg: 'bg-accent-dim',
    colorVar: 'var(--color-accent-text)',
    badgeVariant: 'accent',
  },
  Repository: {
    iconName: 'gitBranch',
    label: 'Repository',
    toneClass: 'text-ok',
    toneBg: 'bg-[color-mix(in_oklab,var(--color-ok),transparent_85%)]',
    colorVar: 'var(--color-ok)',
    badgeVariant: 'ok',
  },
  Deployment: {
    iconName: 'deployment',
    label: 'Deployment',
    toneClass: 'text-warn',
    toneBg: 'bg-[color-mix(in_oklab,var(--color-warn),transparent_85%)]',
    colorVar: 'var(--color-warn)',
    badgeVariant: 'warn',
  },
  Pipeline: {
    iconName: 'workflow',
    label: 'Pipeline',
    toneClass: 'text-pink',
    toneBg: 'bg-[color-mix(in_oklab,var(--color-pink),transparent_85%)]',
    colorVar: 'var(--color-pink)',
    badgeVariant: 'pink',
  },
  Monitor: {
    iconName: 'activity',
    label: 'Monitor',
    toneClass: 'text-err',
    toneBg: 'bg-[color-mix(in_oklab,var(--color-err),transparent_85%)]',
    colorVar: 'var(--color-err)',
    badgeVariant: 'err',
  },
  Team: {
    iconName: 'users',
    label: 'Team',
    toneClass: 'text-purple',
    toneBg: 'bg-[color-mix(in_oklab,var(--color-purple),transparent_85%)]',
    colorVar: 'var(--color-purple)',
    badgeVariant: 'purple',
  },
  Person: {
    iconName: 'person',
    label: 'Person',
    toneClass: 'text-text-muted',
    toneBg: 'bg-panel-2',
    colorVar: 'var(--color-text-muted)',
    badgeVariant: 'neutral',
  },
});
