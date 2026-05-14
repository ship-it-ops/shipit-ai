import type { DeploymentContext, IncidentIntegration } from './types';

/**
 * Kubernetes adapter.
 *
 * Configuration: `NEXT_PUBLIC_K8S_CONSOLE_URL` — a URL template with
 * `{cluster}`, `{namespace}`, `{name}` placeholders. Examples:
 *   - Argo CD:  `https://argo.acme.com/applications/{namespace}/{name}`
 *   - Lens:     `lens://catalog/general/{cluster}/{namespace}/{name}`
 *   - Generic:  `https://k8s-console.acme.com/{cluster}/{namespace}/{name}`
 *
 * Without the template the adapter is inert. The catalog connector
 * populates Deployment.cluster / namespace / name; if any are missing, we
 * return null so the panel hides the link rather than render a broken one.
 */
export const kubernetesAdapter: IncidentIntegration = {
  id: 'kubernetes',
  name: 'Kubernetes',

  isConfigured() {
    return Boolean(process.env.NEXT_PUBLIC_K8S_CONSOLE_URL);
  },

  deploymentUrl(deployment: DeploymentContext) {
    const tpl = process.env.NEXT_PUBLIC_K8S_CONSOLE_URL;
    if (!tpl) return null;
    if (!deployment.cluster || !deployment.namespace) return null;
    return tpl
      .replace('{cluster}', encodeURIComponent(deployment.cluster))
      .replace('{namespace}', encodeURIComponent(deployment.namespace))
      .replace('{name}', encodeURIComponent(deployment.name));
  },
};
