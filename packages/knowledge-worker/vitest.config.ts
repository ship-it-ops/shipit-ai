import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Workspace packages resolve to their TypeScript SOURCE, not `dist/`, so the
// suite is independent of build state (same fix as the other packages).
const r = (...p: string[]) => resolve(__dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/agents': r('agents/src/index.ts'),
      '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
      '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
      '@shipit-ai/knowledge': r('knowledge/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
