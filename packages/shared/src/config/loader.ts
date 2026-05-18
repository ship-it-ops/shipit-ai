import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, type Config } from './schema.js';
import { findConfigPaths } from './find-root.js';

export interface LoadConfigOptions {
  basePath?: string;
  localPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;

  let basePath = options.basePath;
  let localPath = options.localPath;
  if (!basePath) {
    const found = findConfigPaths();
    basePath = found.basePath;
    if (!localPath) localPath = found.localPath;
  }

  const base = readYaml(basePath);
  const local = localPath && existsSync(localPath) ? readYaml(localPath) : undefined;
  const merged = local ? deepMerge(base, local) : base;
  const substituted = substituteEnv(merged, env, []);

  const result = configSchema.safeParse(substituted);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed for ${basePath}:\n${issues}`);
  }
  return result.data;
}

function readYaml(path: string): unknown {
  try {
    return parseYaml(readFileSync(path, 'utf-8')) ?? {};
  } catch (err) {
    throw new Error(`Failed to read config at ${path}: ${(err as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

function substituteEnv(value: unknown, env: NodeJS.ProcessEnv, path: string[]): unknown {
  if (typeof value === 'string') {
    return substituteString(value, env, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => substituteEnv(item, env, [...path, String(i)]));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteEnv(v, env, [...path, k]);
    }
    return out;
  }
  return value;
}

function substituteString(input: string, env: NodeJS.ProcessEnv, path: string[]): string {
  return input.replace(ENV_PLACEHOLDER, (_, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    throw new Error(
      `Config error at ${path.join('.')}: references env var ${name} which is not set ` +
        `(use \${${name}:-default} to provide a fallback)`,
    );
  });
}
