import type { IncidentIntegration, PersonContext, ServiceContext } from './types';

/**
 * PagerDuty adapter.
 *
 * Configuration: `NEXT_PUBLIC_PAGERDUTY_SUBDOMAIN` (e.g., "acme-pay" for
 * https://acme-pay.pagerduty.com). When the connector is wired in Phase 2 it
 * will populate `pd_service_id` / `pd_user_id` properties on Service /
 * Person nodes; for Phase 1 we fall back to the global incidents view —
 * still better than no link.
 */
export const pagerDutyAdapter: IncidentIntegration = {
  id: 'pagerduty',
  name: 'PagerDuty',

  isConfigured() {
    return Boolean(process.env.NEXT_PUBLIC_PAGERDUTY_SUBDOMAIN);
  },

  serviceDashboardUrl(service: ServiceContext) {
    const subdomain = process.env.NEXT_PUBLIC_PAGERDUTY_SUBDOMAIN;
    if (!subdomain) return null;
    // Until the PD connector populates pd_service_id, deeplink to the
    // services list filtered by name. Better to land in the right product
    // than not at all.
    return `https://${subdomain}.pagerduty.com/service-directory?query=${encodeURIComponent(service.name)}`;
  },

  pageOnCallUrl(person: PersonContext, _service: ServiceContext) {
    const subdomain = process.env.NEXT_PUBLIC_PAGERDUTY_SUBDOMAIN;
    if (!subdomain) return null;
    // PD's "page user" UX lives on the user profile. With email available
    // we can deeplink to the directory; otherwise to the on-call list.
    if (person.email) {
      return `https://${subdomain}.pagerduty.com/users?query=${encodeURIComponent(person.email)}`;
    }
    return `https://${subdomain}.pagerduty.com/on-call`;
  },

  declareIncidentUrl(service: ServiceContext) {
    const subdomain = process.env.NEXT_PUBLIC_PAGERDUTY_SUBDOMAIN;
    if (!subdomain) return null;
    // PD's "new incident" flow takes a service id we don't have yet; the
    // incidents list is the next-best landing.
    return `https://${subdomain}.pagerduty.com/incidents/new?service=${encodeURIComponent(service.name)}`;
  },
};
