import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GitHubAppManifestService,
  resolveManifestTemplatePath,
} from '../../services/github-app-manifest-service.js';
import { GsmSecretStore, type GsmClientLike } from '../../secrets/gsm-store.js';
import type { GitHubAppService } from '../../services/github-app-service.js';

// Realistic conversion payload from GitHub's manifest API.
const conversionPayload = {
  id: 99,
  name: 'shipit-test',
  slug: 'shipit-test',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
  webhook_secret: 'hush',
  client_id: 'Iv1.abc123',
  client_secret: 'oauth-s3cret',
};

// Env keys set by the GSM path — cleaned up after every test.
const GSM_ENV_KEYS = [
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY_PATH',
] as const;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'shipit-manifest-svc-'));
}

function writeManifestTemplate(dir: string): string {
  const tmplPath = join(dir, 'manifest.json');
  writeFileSync(
    tmplPath,
    JSON.stringify({
      name: 'ShipIt-AI',
      url: 'https://example.invalid',
      default_permissions: { contents: 'read' },
      default_events: ['push'],
      hook_attributes: { url: 'PLACEHOLDER', active: true },
      redirect_url: 'PLACEHOLDER',
    }),
    'utf-8',
  );
  return tmplPath;
}

function makeStubAppService(): GitHubAppService {
  return { update: vi.fn().mockResolvedValue(undefined) } as unknown as GitHubAppService;
}

function makeFetchMock(payload: unknown): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function makeRecordingGsmClient(): {
  client: GsmClientLike;
  calls: Array<{ parent: string; data: string }>;
} {
  const calls: Array<{ parent: string; data: string }> = [];
  const client: GsmClientLike = {
    accessSecretVersion: vi.fn().mockResolvedValue([{ payload: { data: null } }]),
    addSecretVersion: vi
      .fn()
      .mockImplementation(async (req: { parent: string; payload: { data: Buffer } }) => {
        calls.push({ parent: req.parent, data: req.payload.data.toString('utf-8') });
      }),
  };
  return { client, calls };
}

describe('GitHubAppManifestService — GSM persistence', () => {
  let tmpDir: string;
  let keyDir: string;
  let tmplPath: string;

  // Each test gets a fresh tmp directory; env keys are cleaned up after each test.
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    for (const key of GSM_ENV_KEYS) {
      delete process.env[key];
    }
  });

  function setup() {
    tmpDir = makeTmpDir();
    keyDir = join(tmpDir, 'keys');
    tmplPath = writeManifestTemplate(tmpDir);
  }

  it('GSM mode persists the connector secrets and updates process.env (NOT the OAuth client)', async () => {
    setup();
    const { client, calls } = makeRecordingGsmClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });

    const svc = new GitHubAppManifestService({
      templatePath: tmplPath,
      appService: makeStubAppService(),
      keyDir,
      fetchImpl: makeFetchMock(conversionPayload),
      secretStore: store,
    });

    const result = await svc.exchangeAndPersist('code-123', {});

    // persistedToGsm flag
    expect(result.persistedToGsm).toBe(true);

    // Build a map of container → value for easy assertions
    const written = new Map(
      calls.map((c) => {
        // parent is `projects/proj/secrets/<container>`
        const container = c.parent.replace('projects/proj/secrets/', '');
        return [container, c.data];
      }),
    );

    // Connector secrets are written…
    expect(written.get('shipit-github-app-private-key')).toBe(conversionPayload.pem);
    expect(written.get('shipit-github-webhook-secret')).toBe('hush');
    expect(written.get('shipit-github-app-id')).toBe('99');
    // …but the login OAuth client is OWNED by the setup wizard's classic
    // OAuth App and must NEVER be written by the connector manifest flow
    // (otherwise creating a connector App would clobber login).
    expect(written.has('shipit-github-oauth-client-id')).toBe(false);
    expect(written.has('shipit-github-oauth-client-secret')).toBe(false);

    // process.env updated for the running process
    expect(process.env.GITHUB_WEBHOOK_SECRET).toBe('hush');
    expect(process.env.GITHUB_APP_ID).toBe('99');
    expect(process.env.GITHUB_APP_PRIVATE_KEY_PATH).toMatch(/github-app-99\.pem$/);
    // The OAuth env vars stay untouched by the connector flow.
    expect(process.env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
    expect(process.env.GITHUB_OAUTH_CLIENT_SECRET).toBeUndefined();
  });

  it('file mode / no store: persistedToGsm is false', async () => {
    setup();
    // Service constructed WITHOUT a secretStore
    const svc = new GitHubAppManifestService({
      templatePath: tmplPath,
      appService: makeStubAppService(),
      keyDir,
      fetchImpl: makeFetchMock(conversionPayload),
    });

    const result = await svc.exchangeAndPersist('code-no-store', {});

    expect(result.persistedToGsm).toBe(false);
  });

  it("target='instance' performs zero GSM writes even with a gsm store", async () => {
    setup();
    const { client, calls } = makeRecordingGsmClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });

    const svc = new GitHubAppManifestService({
      templatePath: tmplPath,
      appService: makeStubAppService(),
      keyDir,
      fetchImpl: makeFetchMock(conversionPayload),
      secretStore: store,
    });

    // Per-org Apps must never land in the global GSM containers — the
    // global containers mirror the global App slot (see the gate in
    // exchangeAndPersist).
    const result = await svc.exchangeAndPersist('code-inst', { target: 'instance', nonce: 'n1' });

    expect(result.persistedToGsm).toBe(false);
    expect(calls.length).toBe(0);
    expect(process.env.GITHUB_APP_ID).toBeUndefined();
  });

  it('GSM write failure surfaces container name and recovery hint', async () => {
    setup();
    const permissionErr = Object.assign(new Error('permission denied'), { code: 7 });
    const client: GsmClientLike = {
      accessSecretVersion: vi.fn().mockResolvedValue([{ payload: { data: null } }]),
      addSecretVersion: vi.fn().mockRejectedValue(permissionErr),
    };
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });

    const svc = new GitHubAppManifestService({
      templatePath: tmplPath,
      appService: makeStubAppService(),
      keyDir,
      fetchImpl: makeFetchMock(conversionPayload),
      secretStore: store,
    });

    // A single rejection must contain both the container name AND the recovery hint.
    const rejection = svc.exchangeAndPersist('code-fail', {});
    await expect(rejection).rejects.toThrow(/shipit-github-app-private-key/);
    await expect(rejection).rejects.toThrow(/key is on disk/);
  });

  it('skips empty values — only PEM + app-id written when webhook_secret absent', async () => {
    setup();
    const payloadNoWebhook = {
      id: 42,
      name: 'no-hook',
      slug: 'no-hook',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----\n',
      webhook_secret: null,
      client_id: undefined,
      client_secret: undefined,
    };

    const { client, calls } = makeRecordingGsmClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });

    const svc = new GitHubAppManifestService({
      templatePath: tmplPath,
      appService: makeStubAppService(),
      keyDir,
      fetchImpl: makeFetchMock(payloadNoWebhook),
      secretStore: store,
    });

    const result = await svc.exchangeAndPersist('code-nohook', {});
    expect(result.persistedToGsm).toBe(true);

    const containers = calls.map((c) => c.parent.replace('projects/proj/secrets/', ''));
    // Only PEM + app-id should have been written (webhook, client_id, client_secret skipped)
    expect(containers).toContain('shipit-github-app-private-key');
    expect(containers).toContain('shipit-github-app-id');
    expect(containers).not.toContain('shipit-github-webhook-secret');
    expect(containers).not.toContain('shipit-github-oauth-client-id');
    expect(containers).not.toContain('shipit-github-oauth-client-secret');

    // Env vars for absent values must NOT be set
    expect(process.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(process.env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
    expect(process.env.GITHUB_OAUTH_CLIENT_SECRET).toBeUndefined();
  });
});

// buildManifest reads the template at REQUEST time + substitutes the runtime
// URLs, and exchangeAndPersist POSTs the conversion code to GitHub. These cover
// #8's gaps the GSM-persistence block above doesn't: the request-time template
// ENOENT (the setup-wizard-manifest-launch scar) surfacing a clear error rather
// than a cryptic 500, the URL substitution, and the conversion POST shape.
describe('GitHubAppManifestService — buildManifest + conversion POST shape', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function svcWithTemplate(
    templatePath: string,
    fetchImpl?: typeof fetch,
  ): GitHubAppManifestService {
    return new GitHubAppManifestService({
      templatePath,
      appService: makeStubAppService(),
      keyDir: join(tmpDir, 'keys'),
      fetchImpl: fetchImpl ?? makeFetchMock(conversionPayload),
    });
  }

  it('substitutes redirect_url + hook_attributes from the runtime args', () => {
    tmpDir = makeTmpDir();
    const svc = svcWithTemplate(writeManifestTemplate(tmpDir));

    const { manifest, webhookOmitted } = svc.buildManifest({
      webhookUrl: 'https://portal.example.com/api/webhooks/github',
      redirectUrl: 'https://portal.example.com/api/connectors/github/app-manifest-callback',
    });

    expect(webhookOmitted).toBe(false);
    expect(manifest.redirect_url).toBe(
      'https://portal.example.com/api/connectors/github/app-manifest-callback',
    );
    expect(manifest.hook_attributes).toEqual({
      url: 'https://portal.example.com/api/webhooks/github',
      active: true,
    });
    // Connector-only manifest — never carries login callback_urls.
    expect(manifest.callback_urls).toBeUndefined();
  });

  it('throws a CLEAR, actionable error when the template is absent at request time', () => {
    tmpDir = makeTmpDir();
    // Point at a path that was never written — simulates a broken image where
    // the template didn't make it into the deploy output.
    const missing = join(tmpDir, 'does-not-exist.json');
    const svc = svcWithTemplate(missing);

    expect(() =>
      svc.buildManifest({ webhookUrl: 'https://x.test/h', redirectUrl: 'https://x.test/cb' }),
    ).toThrow(/manifest template not readable/);
    // The message names the path and the override env so an operator can fix it,
    // instead of a bare "ENOENT" bubbling up as a cryptic 500.
    expect(() =>
      svc.buildManifest({ webhookUrl: 'https://x.test/h', redirectUrl: 'https://x.test/cb' }),
    ).toThrow(/SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE/);
  });

  it('POSTs the conversion code to the GitHub manifest-conversion endpoint with the API headers', async () => {
    tmpDir = makeTmpDir();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(conversionPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const svc = svcWithTemplate(writeManifestTemplate(tmpDir), fetchMock);

    await svc.exchangeAndPersist('the-code-42', {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.github.com/app-manifests/the-code-42/conversions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('surfaces a clear error when GitHub rejects the conversion (non-2xx)', async () => {
    tmpDir = makeTmpDir();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('code expired', { status: 422, statusText: 'Unprocessable Entity' }),
      ) as unknown as typeof fetch;
    const svc = svcWithTemplate(writeManifestTemplate(tmpDir), fetchMock);

    await expect(svc.exchangeAndPersist('stale-code', {})).rejects.toThrow(
      /conversion failed: HTTP 422/,
    );
  });
});

// The template must ship inside the api-server package: deployed images are
// `pnpm deploy --prod` output and never contain the repo root, so resolving
// the template relative to the config file's directory (the old behavior)
// ENOENTs on-cluster — see
// docs/agent/investigations/setup-wizard-manifest-launch-enoent.md.
describe('resolveManifestTemplatePath', () => {
  afterEach(() => {
    delete process.env.SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE;
  });

  it('returns the SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE override, resolved to absolute', () => {
    process.env.SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE = './somewhere/manifest.json';
    expect(resolveManifestTemplatePath()).toBe(resolve('./somewhere/manifest.json'));
  });

  it('defaults to a template file shipped inside the api-server package', () => {
    const path = resolveManifestTemplatePath();
    expect(path).toContain(join('api-server', 'config', 'github-app-manifest.json'));
    expect(existsSync(path)).toBe(true);
    // Sanity-check it parses as a GitHub App manifest template.
    const template = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(template.name).toBeTruthy();
    expect(template.default_permissions).toBeTruthy();
  });
});
