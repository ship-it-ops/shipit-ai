import { clientConfig } from '../client-config';
import type { DeploymentContext, IncidentIntegration } from './types';

/**
 * Kubernetes adapter.
 *
 * Configuration: `frontend.integrations.kubernetes.consoleUrlTemplate` in
 * shipit.config.yaml — a URL template with `{cluster}`, `{namespace}`,
 * `{name}` placeholders. Examples:
 *   - Argo CD:  `https://argo.shipitops.com/applications/{namespace}/{name}`
 *   - Lens:     `lens://catalog/general/{cluster}/{namespace}/{name}`
 *   - Generic:  `https://k8s-console.shipitops.com/{cluster}/{namespace}/{name}`
 *
 * Without the template the adapter is inert. The catalog connector
 * populates Deployment.cluster / namespace / name; if any are missing, we
 * return null so the panel hides the link rather than render a broken one.
 */
export const kubernetesAdapter: IncidentIntegration = {
  id: 'kubernetes',
  name: 'Kubernetes',

  isConfigured() {
    return Boolean(clientConfig.integrations.kubernetes.consoleUrlTemplate);
  },

  deploymentUrl(deployment: DeploymentContext) {
    const tpl = clientConfig.integrations.kubernetes.consoleUrlTemplate;
    if (!tpl) return null;
    if (!deployment.cluster || !deployment.namespace) return null;
    return tpl
      .replace('{cluster}', encodeURIComponent(deployment.cluster))
      .replace('{namespace}', encodeURIComponent(deployment.namespace))
      .replace('{name}', encodeURIComponent(deployment.name));
  },
};
