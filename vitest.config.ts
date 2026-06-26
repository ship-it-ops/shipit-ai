import { defineConfig } from 'vitest/config';

// Vitest 4 removed `defineWorkspace`/`vitest.workspace.ts`; the workspace is
// now declared as `test.projects` in the root config. Each string entry points
// at a package whose own vitest/vite config (or defaults) defines its tests;
// the inline entry keeps the standalone `scripts` suite.
export default defineConfig({
  test: {
    projects: [
      'packages/shared',
      'packages/event-bus',
      'packages/core-writer',
      'packages/connector-sdk',
      'packages/connectors/github',
      'packages/connectors/kubernetes',
      'packages/api-server',
      'packages/mcp-server',
      'packages/web-ui',
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
