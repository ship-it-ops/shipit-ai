import { defineConfig } from 'vitest/config';

// Explicit (default-settings) project config. Two reasons it must exist:
//  1. Vitest 4 discovers configs by walking up from the cwd; without a local
//     config a per-package `vitest run` would climb to the root
//     `vitest.config.ts` and resolve its `test.projects` relative to this
//     package. A local config stops that walk.
//  2. Vitest 4 dropped `dist` from its default `exclude`, so the compiled
//     `dist/**/*.test.js` copies would be collected alongside the sources.
//     Scoping `include` to `src` keeps the run to TypeScript sources only.
export default defineConfig({
  test: {
    name: 'mcp-server',
    include: ['src/**/*.test.ts'],
  },
});
