import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiException } from '@kubernetes/client-node';
import {
  KubernetesError,
  buildKubeConfig,
  classifyError,
  parseCredentials,
  validateKubeconfigText,
  SERVICE_ACCOUNT_TOKEN_PATH,
} from '../auth.js';

// node:fs's module namespace is not configurable under Vitest's ESM runner
// (vi.spyOn throws "Cannot redefine property"), so the readFileSync guarantee
// below mocks the module instead, wrapping the real implementation in a
// vi.fn() we can assert against. @kubernetes/client-node imports `fs` as a
// default import from 'node:fs', so both the default and named export must
// carry the same mock function reference.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = vi.fn(actual.readFileSync);
  return {
    ...actual,
    readFileSync,
    default: { ...actual, readFileSync },
  } as unknown as typeof import('node:fs');
});
const readFileSyncMock = vi.mocked((await import('node:fs')).readFileSync);

const tokenKubeconfig = (extraContexts = '') => `
apiVersion: v1
kind: Config
clusters:
- name: demo
  cluster:
    server: https://10.0.0.1:6443
    certificate-authority-data: ${Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n').toString('base64')}
users:
- name: reader
  user:
    token: abc123
contexts:
- name: demo
  context:
    cluster: demo
    user: reader
${extraContexts}
current-context: demo
`;

const execKubeconfig = `
apiVersion: v1
kind: Config
clusters:
- name: gke
  cluster:
    server: https://34.1.2.3
    certificate-authority-data: ${Buffer.from('x').toString('base64')}
users:
- name: gke
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
contexts:
- name: gke
  context: { cluster: gke, user: gke }
current-context: gke
`;

describe('parseCredentials', () => {
  it('maps the three modes and rejects incomplete or unknown ones', () => {
    expect(parseCredentials({ mode: 'in-cluster' })).toEqual({ mode: 'in-cluster' });
    expect(parseCredentials({ mode: 'kubeconfig', kubeconfig: 'x', context: '' })).toEqual({
      mode: 'kubeconfig',
      kubeconfig: 'x',
      context: undefined,
    });
    expect(
      parseCredentials({ mode: 'token', server: 'https://h', token: 't', caData: 'Y2E=' }),
    ).toEqual({
      mode: 'token',
      server: 'https://h',
      token: 't',
      caData: 'Y2E=',
    });
    expect(() => parseCredentials({ mode: 'kubeconfig' })).toThrow(KubernetesError);
    expect(() => parseCredentials({ mode: 'token', server: 'https://h' })).toThrow(/token/);
    expect(() => parseCredentials({})).toThrow(/unknown access mode/);
  });
});

describe('validateKubeconfigText', () => {
  it('accepts a single-context token kubeconfig', () => {
    expect(validateKubeconfigText(tokenKubeconfig())).toEqual({
      ok: true,
      contexts: ['demo'],
      currentContext: 'demo',
    });
  });

  it('requires an explicit context when several exist, and accepts it when given', () => {
    const two = tokenKubeconfig(`- name: other
  context:
    cluster: demo
    user: reader`);
    expect(validateKubeconfigText(two)).toMatchObject({ ok: false, code: 'KUBECONFIG_INVALID' });
    expect(validateKubeconfigText(two, 'other')).toMatchObject({
      ok: true,
      currentContext: 'other',
    });
    expect(validateKubeconfigText(two, 'missing')).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('rejects exec/auth-provider users with UNSUPPORTED_AUTH_PLUGIN', () => {
    expect(validateKubeconfigText(execKubeconfig)).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_AUTH_PLUGIN',
    });
  });

  it('rejects insecure-skip-tls-verify, file references and unparseable text', () => {
    const insecure = tokenKubeconfig().replace(
      'certificate-authority-data',
      'insecure-skip-tls-verify: true\n    certificate-authority-data',
    );
    expect(validateKubeconfigText(insecure)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
    const fileRef = tokenKubeconfig().replace(
      /certificate-authority-data: .*/,
      'certificate-authority: /etc/ca.crt',
    );
    expect(validateKubeconfigText(fileRef)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
    expect(validateKubeconfigText('not: [valid')).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('rejects token-file without ever reading the referenced file off disk', () => {
    readFileSyncMock.mockClear();
    const tokenFile = tokenKubeconfig().replace('token: abc123', 'token-file: /etc/hosts');
    expect(validateKubeconfigText(tokenFile)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
    expect(readFileSyncMock).not.toHaveBeenCalledWith('/etc/hosts', expect.anything());
    expect(readFileSyncMock).not.toHaveBeenCalledWith('/etc/hosts');
  });

  it('rejects certificate-authority file references via the pre-parse check', () => {
    const fileRef = tokenKubeconfig().replace(
      /certificate-authority-data: .*/,
      'certificate-authority: /etc/ca.crt',
    );
    expect(validateKubeconfigText(fileRef)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('never echoes kubeconfig contents (e.g. a bearer token) into a parse-error message', () => {
    const malformed = `not valid yaml: [\ntoken: SUPER-SECRET-TOKEN-abc123`;
    const result = validateKubeconfigText(malformed);
    expect(result).toMatchObject({ ok: false, code: 'KUBECONFIG_INVALID' });
    expect((result as { message: string }).message).not.toContain('SUPER-SECRET');
  });
});

describe('buildKubeConfig', () => {
  it('in-cluster fails fast without a ServiceAccount token', () => {
    expect(() =>
      buildKubeConfig({ mode: 'in-cluster' }, { env: {}, fileExists: () => false }),
    ).toThrow(/IN_CLUSTER_UNAVAILABLE/);
    expect(() =>
      buildKubeConfig(
        { mode: 'in-cluster' },
        { env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, fileExists: () => false },
      ),
    ).toThrow(/IN_CLUSTER_UNAVAILABLE/);
  });

  describe('when the ServiceAccount token file exists', () => {
    const prevHost = process.env.KUBERNETES_SERVICE_HOST;
    const prevPort = process.env.KUBERNETES_SERVICE_PORT;

    afterEach(() => {
      if (prevHost === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
      else process.env.KUBERNETES_SERVICE_HOST = prevHost;
      if (prevPort === undefined) delete process.env.KUBERNETES_SERVICE_PORT;
      else process.env.KUBERNETES_SERVICE_PORT = prevPort;
    });

    it('loads the ServiceAccount config', () => {
      // client-node's loadFromCluster() reads KUBERNETES_SERVICE_HOST/PORT from
      // process.env directly, so the real env must carry them too; the probe's
      // env is only consulted to gate the attempt.
      process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
      process.env.KUBERNETES_SERVICE_PORT = '443';
      const kc = buildKubeConfig(
        { mode: 'in-cluster' },
        {
          env: { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '443' },
          fileExists: (p) => p === SERVICE_ACCOUNT_TOKEN_PATH,
        },
      );
      expect(kc.getCurrentCluster()?.server).toBe('https://10.0.0.1:443');
    });
  });

  it('token mode builds a single-context config with TLS verification on', () => {
    const kc = buildKubeConfig({
      mode: 'token',
      server: 'https://h:6443',
      token: 't',
      caData: 'Y2E=',
    });
    expect(kc.getCurrentCluster()).toMatchObject({
      server: 'https://h:6443',
      caData: 'Y2E=',
      skipTLSVerify: false,
    });
    expect(kc.getCurrentUser()?.token).toBe('t');
  });

  it('kubeconfig mode validates then selects the context', () => {
    const kc = buildKubeConfig({ mode: 'kubeconfig', kubeconfig: tokenKubeconfig() });
    expect(kc.getCurrentContext()).toBe('demo');
    expect(() => buildKubeConfig({ mode: 'kubeconfig', kubeconfig: execKubeconfig })).toThrow(
      /UNSUPPORTED_AUTH_PLUGIN/,
    );
  });
});

describe('classifyError', () => {
  it('maps API status codes, network errors, TLS errors and timeouts', () => {
    expect(classifyError(new ApiException(401, 'Unauthorized', {}, {}))).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(classifyError(new ApiException(403, 'deployments is forbidden', {}, {}))).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(classifyError(new ApiException(500, 'boom', {}, {}))).toMatchObject({
      code: 'API_ERROR',
      status: 500,
    });
    expect(
      classifyError(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
        }),
      ),
    ).toMatchObject({ code: 'API_UNREACHABLE' });
    expect(
      classifyError(
        Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      ),
    ).toMatchObject({ code: 'TLS_ERROR' });
    expect(classifyError(new Error('weird'))).toMatchObject({ code: 'API_ERROR' });
  });

  it('classifies KubernetesError as a passthrough and every timeout signal as TIMEOUT', () => {
    expect(
      classifyError(new KubernetesError('TIMEOUT', 'list pods exceeded 30000 ms')),
    ).toMatchObject({ code: 'TIMEOUT' });
    expect(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toMatchObject({
      code: 'TIMEOUT',
    });
    expect(classifyError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toMatchObject({
      code: 'TIMEOUT',
    });
    expect(
      classifyError(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'timeout' },
        }),
      ),
    ).toMatchObject({ code: 'TIMEOUT' });
  });

  it('never leaks ApiException headers/body into the classified message', () => {
    const forbidden = classifyError(
      new ApiException(
        403,
        'HTTP-Code: 403\nMessage: x\nBody: {"message":"deployments is forbidden"}\nHeaders: {"set-cookie":"SECRETCOOKIE"}',
        { message: 'deployments is forbidden' },
        { 'set-cookie': 'SECRETCOOKIE' },
      ),
    );
    expect(forbidden.message).toContain('deployments is forbidden');
    expect(forbidden.message).not.toContain('SECRETCOOKIE');

    const noBodyMessage = classifyError(new ApiException(500, 'boom', 'not an object', {}));
    expect(noBodyMessage.message).toContain('HTTP 500');
  });
});
