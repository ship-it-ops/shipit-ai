import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Vitest 4 no longer excludes `dist` by default; scope to TS sources.
    include: ['src/**/*.test.ts'],
  },
});
