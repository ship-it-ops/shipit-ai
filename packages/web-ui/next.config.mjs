import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

// Load shipit.config.yaml + shipit.config.local.yaml at build time and flatten
// the `frontend.*` subtree into NEXT_PUBLIC_SHIPIT_<DOT_PATH> env vars. The
// web-ui's lib/client-config.ts reads those at runtime; Next.js inlines the
// literal process.env reads into the client bundle at build time.
//
// Why duplicate the loader instead of importing @shipit-ai/shared? Turbo dev
// runs all packages in parallel, so shared may not be built when next.config
// evaluates. Inlining keeps web-ui's build self-contained — at the cost of
// ~30 lines of repetition with packages/shared/src/config/loader.ts.
function loadShipitFrontendConfig() {
  const merged = loadMergedConfig();
  // Only substitute env on the frontend subtree — the backend tree may
  // reference required-without-fallback vars (e.g. ${NEO4J_PASSWORD}) that
  // aren't relevant to or present during a frontend build.
  return substituteEnv(merged.frontend ?? {}, ['frontend']);
}

function loadShipitAuthFlags() {
  // accessControl drives the web-UI middleware: when auth.enabled is true
  // the middleware redirects unauthenticated requests to /login, and the
  // session-cookie name has to match what @fastify/session writes from
  // the api-server. Both knobs are surfaced as NEXT_PUBLIC vars so the
  // middleware can read them at edge-runtime without needing to load the
  // YAML at request time.
  //
  // providersEnabled also rides along so the login page can diagnose
  // "no providers configured" even when the api-server is unreachable —
  // which is exactly what happens when an operator flips auth.enabled to
  // true without enabling any provider (the api-server fails closed at
  // boot, so /api/auth/providers becomes uncallable). Without this hint
  // the page would fall back to a generic "API server down" message and
  // miss the real root cause.
  const merged = loadMergedConfig();
  const auth = merged.accessControl?.auth ?? {};
  const providers = auth.providers ?? {};
  const providersEnabled = [];
  if (providers.oidc?.enabled === true) providersEnabled.push('oidc');
  if (providers.github?.enabled === true) providersEnabled.push('github');
  return {
    enabled: auth.enabled === true,
    cookieName:
      typeof auth.session?.cookieName === 'string' ? auth.session.cookieName : 'shipit_sid',
    providersEnabled,
  };
}

function loadMergedConfig() {
  const basePath = join(repoRoot, 'shipit.config.yaml');
  const localPath = join(repoRoot, 'shipit.config.local.yaml');
  if (!existsSync(basePath)) {
    throw new Error(`Missing ${basePath}. Run \`pnpm preflight\` to bootstrap.`);
  }
  const base = parseYaml(readFileSync(basePath, 'utf-8')) ?? {};
  const local = existsSync(localPath) ? (parseYaml(readFileSync(localPath, 'utf-8')) ?? {}) : {};
  return deepMerge(base, local);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

function substituteEnv(value, path) {
  if (typeof value === 'string') {
    return value.replace(ENV_PLACEHOLDER, (_, name, fallback) => {
      const v = process.env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new Error(
        `Config error at ${path.join('.')}: env var ${name} is not set ` +
          `(use \${${name}:-default} for a fallback)`,
      );
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => substituteEnv(v, [...path, String(i)]));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteEnv(v, [...path, k]);
    return out;
  }
  return value;
}

// Flatten the `frontend` subtree into NEXT_PUBLIC_SHIPIT_<UPPER_SNAKE_PATH>
// keys. Arrays of strings are comma-joined (CSV) so they survive the env
// round-trip; client-config.ts re-splits them.
function flattenForBuild(node, prefix, out) {
  if (node === null || node === undefined) {
    // Skip — client-config.ts treats missing keys as null.
    return out;
  }
  if (Array.isArray(node)) {
    out[prefix] = node.join(',');
    return out;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      const key = camelToSnake(k);
      flattenForBuild(v, prefix ? `${prefix}_${key}` : key, out);
    }
    return out;
  }
  out[prefix] = String(node);
  return out;
}

function camelToSnake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

const frontend = loadShipitFrontendConfig();
const flat = flattenForBuild(frontend, '', {});
const envBlock = {};
for (const [k, v] of Object.entries(flat)) {
  envBlock[`NEXT_PUBLIC_SHIPIT_${k}`] = v;
}
const authFlags = loadShipitAuthFlags();
envBlock.NEXT_PUBLIC_SHIPIT_AUTH_ENABLED = authFlags.enabled ? 'true' : 'false';
envBlock.NEXT_PUBLIC_SHIPIT_AUTH_COOKIE_NAME = authFlags.cookieName;
envBlock.NEXT_PUBLIC_SHIPIT_AUTH_PROVIDERS_ENABLED = authFlags.providersEnabled.join(',');

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
  env: envBlock,
};

export default nextConfig;
