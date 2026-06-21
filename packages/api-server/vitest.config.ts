import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Resolve @shipit-ai/* workspace packages to their TypeScript SOURCE rather than
// their built `dist/`. The CI `integration` job runs `vitest run .integration`
// straight after `pnpm install` with NO build step, so workspace `dist/`
// directories don't exist there. Under vite 7.3.5 a runtime import of an unbuilt
// workspace package hard-fails with "Failed to resolve entry for package"
// (older vite fell back to source); aliasing to src restores that and makes the
// suite independent of build state. The unit `test` job goes through `turbo`
// (which builds deps first), so it never hit this. vitest transpiles the TS
// source on the fly. See packages/event-bus/vitest.config.ts for the same fix.
//
// `/schema` is listed before the bare `@shipit-ai/shared` so vite's prefix match
// doesn't rewrite the subpath against the package root. Aliases for packages not
// in a given test's graph are simply unused.
const r = (...p: string[]) => resolve(__dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
      '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
      '@shipit-ai/connector-github': r('connectors/github/src/index.ts'),
      '@shipit-ai/connector-kubernetes': r('connectors/kubernetes/src/index.ts'),
      '@shipit-ai/core-writer': r('core-writer/src/index.ts'),
      '@shipit-ai/mcp-server': r('mcp-server/src/index.ts'),
    },
  },
});
