import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Resolve @shipit-ai/* workspace packages to their TypeScript source, so the
// suites run straight after `pnpm install` with no build step (the CI
// `integration` job builds nothing). Subpaths are listed before their package
// root so vite's prefix match does not rewrite them against the root.
const r = (...p: string[]) => resolve(import.meta.dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/agents/testing': r('agents/src/testing.ts'),
      '@shipit-ai/agents': r('agents/src/index.ts'),
      '@shipit-ai/mcp-server/tools': r('mcp-server/src/tools/registry.ts'),
    },
  },
  test: {
    name: 'agent-runner',
    include: ['src/**/*.test.ts'],
  },
});
