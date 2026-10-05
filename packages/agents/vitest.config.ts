import { defineConfig } from 'vitest/config';

// This package has no @shipit-ai/* workspace dependencies, so unlike its
// siblings it needs no source aliases for the unbuilt CI `integration` job.
export default defineConfig({
  test: {
    // Vitest 4 no longer excludes `dist` by default; scope to TS sources so the
    // compiled dist/**/*.test.js copies aren't collected after a build.
    include: ['src/**/*.test.ts'],
  },
});
