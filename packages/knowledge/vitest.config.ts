import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Workspace packages resolve to their TypeScript SOURCE, not `dist/`: the CI
// `integration` job runs vitest straight after `pnpm install` with no build
// step. Same fix as packages/api-server/vitest.config.ts.
const r = (...p: string[]) => resolve(__dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/agents': r('agents/src/index.ts'),
      '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
      '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
    },
  },
  test: {
    // Vitest 4 no longer excludes `dist` by default; scope to TS sources.
    include: ['src/**/*.test.ts'],
  },
});
