// Default store for local dev and CI. Reads resolve from process.env
// (the same vars the app consumes today), so behavior with
// SHIPIT_SECRET_STORE=file is identical to before the store existed.
// Writes update the injected env for the CURRENT PROCESS only — durable
// local persistence stays what it is today (the operator's shell/.env).
// The PEM is never read through this store locally; it stays path-based
// via connectors.github.app.privateKeyPath.
import { assertWritable, ENV_VAR_FOR, type LogicalSecret, type SecretStore } from './types.js';

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;

  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  async read(name: LogicalSecret): Promise<string | null> {
    const envVar = ENV_VAR_FOR[name];
    if (!envVar) return null;
    const value = this.env[envVar];
    return value ? value : null;
  }

  async write(name: LogicalSecret, value: string): Promise<void> {
    assertWritable(name);
    const envVar = ENV_VAR_FOR[name];
    // If name has no env-var mapping (e.g. github-app-private-key, which the
    // manifest service writes only via gsm-kind stores), this is a deliberate
    // no-op: the value is not persisted and a subsequent read() returns null.
    if (envVar) this.env[envVar] = value;
  }
}
