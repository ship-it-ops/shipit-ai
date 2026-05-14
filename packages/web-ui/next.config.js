const path = require('path');
const { loadEnvConfig } = require('@next/env');

// Treat the monorepo root as the canonical .env location. Without this Next
// only scans `packages/web-ui/` and would miss values like
// `NEXT_PUBLIC_DEV_USER_*` and `NEXT_PUBLIC_API_URL` that live alongside the
// rest of the project's config (Neo4j, Redis, GitHub creds, etc.). Loading
// here happens before Next's own env loading, so `process.env` is populated
// for both the dev server and the static build.
loadEnvConfig(path.resolve(__dirname, '../..'), process.env.NODE_ENV !== 'production');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: [
    '@ship-it-ui/ui',
    '@ship-it-ui/tokens',
    '@ship-it-ui/icons',
    '@ship-it-ui/shipit',
  ],
};

module.exports = nextConfig;
