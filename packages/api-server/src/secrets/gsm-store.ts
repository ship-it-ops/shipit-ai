// GSM-backed store. Authenticates via Application Default Credentials —
// on GKE that resolves through the metadata server to the pod's
// Workload Identity (GSA shipit-api-server@<project>). NO explicit
// credentials, NO JSON key files, ever. Containers are Terraform-managed;
// this store never calls createSecret.
//
// The real SecretManagerServiceClient is constructed lazily so tests can
// inject a mock (GsmClientLike) and so merely importing this module
// doesn't pull grpc bootstrap cost into processes that run in file mode.
import { assertWritable, gsmContainerFor, type LogicalSecret, type SecretStore } from './types.js';

// Narrow structural view of SecretManagerServiceClient — the seam tests mock.
export interface GsmClientLike {
  accessSecretVersion(req: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string | null } | null }]>;
  addSecretVersion(req: { parent: string; payload: { data: Buffer } }): Promise<unknown>;
}

const GRPC_NOT_FOUND = 5;

export interface GsmSecretStoreOptions {
  projectId: string;
  env?: NodeJS.ProcessEnv;
  client?: GsmClientLike;
}

export class GsmSecretStore implements SecretStore {
  readonly kind = 'gsm' as const;
  private projectId: string;
  private env: NodeJS.ProcessEnv;
  private client: GsmClientLike | null;

  constructor(opts: GsmSecretStoreOptions) {
    this.projectId = opts.projectId;
    this.env = opts.env ?? process.env;
    this.client = opts.client ?? null;
  }

  private async getClient(): Promise<GsmClientLike> {
    if (!this.client) {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      this.client = new SecretManagerServiceClient() as unknown as GsmClientLike;
    }
    return this.client;
  }

  // Container name for a logical secret — exposed so error messages can
  // tell the operator exactly which GSM container was involved.
  containerFor(name: LogicalSecret): string {
    return gsmContainerFor(name, this.env);
  }

  async read(name: LogicalSecret): Promise<string | null> {
    const client = await this.getClient();
    const container = this.containerFor(name);
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${this.projectId}/secrets/${container}/versions/latest`,
      });
      const data = version.payload?.data;
      if (data == null) return null;
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
      return text.length > 0 ? text : null;
    } catch (err) {
      // NOT_FOUND = the container exists but holds no version yet (or the
      // container name is wrong — IAM makes those indistinguishable).
      // That's the legitimate first-run state, not an error.
      if ((err as { code?: number }).code === GRPC_NOT_FOUND) return null;
      throw err;
    }
  }

  async write(name: LogicalSecret, value: string): Promise<void> {
    assertWritable(name);
    const client = await this.getClient();
    const container = this.containerFor(name);
    await client.addSecretVersion({
      parent: `projects/${this.projectId}/secrets/${container}`,
      payload: { data: Buffer.from(value, 'utf-8') },
    });
  }
}
