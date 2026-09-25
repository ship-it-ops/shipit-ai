import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadKubernetesCredentials } from './api';

describe('uploadKubernetesCredentials', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a kubeconfig and returns the stored path plus the contexts it found', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: 'kubeconfig',
          kubeconfigPath: '/data/keys/kubeconfig-k8s-prod.yaml',
          context: 'prod',
          contexts: ['prod', 'staging'],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await uploadKubernetesCredentials({
      connectorId: 'k8s-prod',
      mode: 'kubeconfig',
      kubeconfig: 'apiVersion: v1\n',
    });

    expect(result).toEqual({
      mode: 'kubeconfig',
      kubeconfigPath: '/data/keys/kubeconfig-k8s-prod.yaml',
      context: 'prod',
      contexts: ['prod', 'staging'],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/api/connectors/kubernetes/credentials');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      connectorId: 'k8s-prod',
      mode: 'kubeconfig',
      kubeconfig: 'apiVersion: v1\n',
    });
  });

  // The server's own message names the offending field (proxy-url, exec,
  // auth-provider, a file reference); the wizard shows it verbatim, so it has
  // to survive the client layer rather than being flattened to a status code.
  it('throws the server message on a rejected kubeconfig, so the wizard can show why', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'KUBECONFIG_INVALID',
            message: 'kubeconfig cluster sets proxy-url, which ShipIt cannot honour',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      uploadKubernetesCredentials({ connectorId: 'k8s-prod', mode: 'kubeconfig', kubeconfig: 'x' }),
    ).rejects.toThrow(/proxy-url/);
  });

  it('posts a token with its optional CA and returns both stored paths', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: 'token',
          tokenPath: '/data/keys/k8s-token-k8s-prod',
          caDataPath: '/data/keys/k8s-ca-k8s-prod.pem',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await uploadKubernetesCredentials({
      connectorId: 'k8s-prod',
      mode: 'token',
      token: 'tok',
      caData: '-----BEGIN CERTIFICATE-----',
    });

    expect(result).toEqual({
      mode: 'token',
      tokenPath: '/data/keys/k8s-token-k8s-prod',
      caDataPath: '/data/keys/k8s-ca-k8s-prod.pem',
    });
  });
});
