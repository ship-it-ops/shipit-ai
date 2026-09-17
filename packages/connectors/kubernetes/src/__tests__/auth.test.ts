import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiException } from '@kubernetes/client-node';
import {
  KubernetesError,
  buildKubeConfig,
  classifyError,
  parseCredentials,
  validateKubeconfigText,
  SERVICE_ACCOUNT_TOKEN_PATH,
} from '../auth.js';

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
    // toMatchObject, not toEqual: a successful result also carries `options`,
    // the allowlisted structure fed to KubeConfig#loadFromOptions.
    expect(validateKubeconfigText(tokenKubeconfig())).toMatchObject({
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

  it('rejects token-file in block style', () => {
    const blockStyle = tokenKubeconfig().replace('token: abc123', 'token-file: /etc/hosts');
    expect(validateKubeconfigText(blockStyle)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('rejects token-file in flow style and behind a quoted key — the YAML parser decodes both to the same key, so no separate regex is needed', () => {
    const flowStyle = tokenKubeconfig().replace(
      '  user:\n    token: abc123',
      '  user: { token-file: /etc/hosts }',
    );
    expect(validateKubeconfigText(flowStyle)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });

    const quotedKey = tokenKubeconfig().replace('token: abc123', '"token-file": /etc/hosts');
    expect(validateKubeconfigText(quotedKey)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('rejects token-file behind a double-quoted YAML-escaped key', () => {
    // `-` is `-`: the key only reads as `token-file` after the YAML parser
    // decodes the escape, so this exercises the decoding path, not the literal.
    const escapedKey = tokenKubeconfig().replace('token: abc123', '"token\\u002Dfile": /etc/hosts');
    expect(validateKubeconfigText(escapedKey)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('never echoes kubeconfig contents (e.g. a bearer token) into a parse-error message', () => {
    const malformed = `not valid yaml: [\ntoken: SUPER-SECRET-TOKEN-abc123`;
    const result = validateKubeconfigText(malformed);
    expect(result).toMatchObject({ ok: false, code: 'KUBECONFIG_INVALID' });
    const message = (result as { message: string }).message;
    expect(message).not.toContain('SUPER-SECRET');
    expect(message).not.toContain('not valid yaml: [');
  });

  it('never lets the yaml parser print a process warning containing kubeconfig contents (e.g. an unresolved tag on a token)', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const tagged = tokenKubeconfig().replace(
        'token: abc123',
        'token: !mytag SUPER-SECRET-TOKEN-abc123',
      );
      // Whether this kubeconfig ends up ok or rejected is irrelevant here —
      // only that parsing it never reaches process.emitWarning, which would
      // print the offending source line (the token) straight to stderr.
      validateKubeconfigText(tagged);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

  it('kubeconfig mode validates then selects the context, carrying only the allowlisted fields into KubeConfig', () => {
    const kc = buildKubeConfig({ mode: 'kubeconfig', kubeconfig: tokenKubeconfig() });
    expect(kc.getCurrentContext()).toBe('demo');
    expect(kc.getCurrentUser()?.token).toBe('abc123');
    expect(kc.getCurrentCluster()?.server).toBe('https://10.0.0.1:6443');
    expect(() => buildKubeConfig({ mode: 'kubeconfig', kubeconfig: execKubeconfig })).toThrow(
      /UNSUPPORTED_AUTH_PLUGIN/,
    );
  });

  it('never reads a token-file off disk: a malicious kubeconfig pointing at a real, readable secret is rejected without the file ever being opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
    const leakPath = join(dir, 'leaked-token');
    writeFileSync(leakPath, 'LEAKED-TOKEN-xyz');
    try {
      const malicious = `
apiVersion: v1
kind: Config
clusters:
- name: demo
  cluster: { server: https://attacker.example }
users:
- name: reader
  user: { token-file: ${leakPath} }
contexts:
- name: demo
  context: { cluster: demo, user: reader }
current-context: demo
`;
      expect(() => buildKubeConfig({ mode: 'kubeconfig', kubeconfig: malicious })).toThrow(
        /KUBECONFIG_INVALID/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
