export { hydrateFromStore, type HydrationResult } from './hydrate.js';
export { FileSecretStore } from './file-store.js';
export { GsmSecretStore, type GsmClientLike } from './gsm-store.js';
export {
  SecretWriteForbiddenError,
  assertWritable,
  gsmContainerFor,
  GSM_CONTAINER_DEFAULTS,
  ENV_VAR_FOR,
  WRITABLE_SECRETS,
  type LogicalSecret,
  type SecretStore,
} from './types.js';

import { FileSecretStore } from './file-store.js';
import { GsmSecretStore } from './gsm-store.js';
import type { SecretStore } from './types.js';

// Selection contract (Q1): infra injects SHIPIT_SECRET_STORE=gsm +
// GOOGLE_CLOUD_PROJECT on the GKE pod; everything else defaults to file.
export function makeSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  const mode = env.SHIPIT_SECRET_STORE?.trim() || 'file';
  if (mode === 'file') return new FileSecretStore(env);
  if (mode === 'gsm') {
    const projectId = env.GOOGLE_CLOUD_PROJECT?.trim();
    if (!projectId) {
      throw new Error(
        'SHIPIT_SECRET_STORE=gsm requires GOOGLE_CLOUD_PROJECT to be set (the GKE chart injects it).',
      );
    }
    return new GsmSecretStore({ projectId, env });
  }
  throw new Error(`Unknown SHIPIT_SECRET_STORE "${mode}" — expected "file" or "gsm".`);
}
