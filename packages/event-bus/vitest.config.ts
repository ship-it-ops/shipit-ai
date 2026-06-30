import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Resolve the @shipit-ai/shared workspace package to its TypeScript SOURCE
// rather than its built `dist/`. The CI `integration` job runs
// `vitest run .integration` directly after `pnpm install` with NO build step,
// so workspace `dist/` directories don't exist there. The unit `test` job goes
// through `turbo` (which builds deps first), which is why it doesn't hit this.
//
// Under vite 7.3.5 a runtime import of an unbuilt workspace package
// (`import { deriveNodeContentHash } from '@shipit-ai/shared'`, pulled in via
// bullmq/client.js) hard-fails with "Failed to resolve entry for package" —
// older vite was lenient and fell back to source. Aliasing to src restores that
// and makes the suite independent of build state. vitest transpiles the TS
// source on the fly, so no prior build is needed.
export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    // Vitest 4 no longer excludes `dist` by default; scope to TS sources so the
    // compiled dist/**/*.test.js copies aren't collected after a build.
    include: ['src/**/*.test.ts'],
  },
});
