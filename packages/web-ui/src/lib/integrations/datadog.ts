import { clientConfig } from '../client-config';
import type { IncidentIntegration, MonitorContext, ServiceContext } from './types';

/**
 * Datadog adapter.
 *
 * Configuration: `frontend.integrations.datadog.site` in shipit.config.yaml
 * (e.g., "datadoghq.com", "datadoghq.eu", "us3.datadoghq.com"). The
 * runtime/observability identity comes from `EMITS_TELEMETRY_AS` edges in the
 * catalog graph — those land on the service as `dd_service` after the
 * depth-1 neighborhood resolves.
 *
 * Phase 1 deeplinks: APM service page, monitor by id (when seeded), monitor
 * search by name (fallback). No declare-incident — Datadog Incident
 * Management's URL contract requires an incident id we don't own.
 */
export const datadogAdapter: IncidentIntegration = {
  id: 'datadog',
  name: 'Datadog',

  isConfigured() {
    return Boolean(clientConfig.integrations.datadog.site);
  },

  serviceDashboardUrl(service: ServiceContext) {
    const site = clientConfig.integrations.datadog.site;
    if (!site) return null;
    // Prefer the resolved Datadog service name (set by EMITS_TELEMETRY_AS).
    // If absent, search by catalog name — APM's service page accepts either.
    const ddName = service.ddService ?? service.name;
    return `https://app.${site}/apm/services/${encodeURIComponent(ddName)}/operations`;
  },

  monitorUrl(monitor: MonitorContext) {
    const site = clientConfig.integrations.datadog.site;
    if (!site) return null;
    if (monitor.url) return monitor.url;
    if (monitor.ddMonitorId) {
      return `https://app.${site}/monitors/${encodeURIComponent(monitor.ddMonitorId)}`;
    }
    return `https://app.${site}/monitors/manage?q=${encodeURIComponent(monitor.name)}`;
  },
};
