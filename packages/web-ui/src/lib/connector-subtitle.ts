import type { Connector } from './api';

/**
 * The line that tells a user WHICH instance a connector is, given its type: the
 * GitHub org, the Kubernetes cluster name. Returns `null` when there is no
 * identifying field — an unknown type, or a malformed record — so callers render
 * nothing instead of the string "undefined".
 *
 * One source of truth on purpose. Before this, `ConnectorCard` had its own
 * `type === 'github' ? org : undefined` ternary and `ConnectorDetailDrawer` read
 * `connector.org` unconditionally, which is why a Kubernetes connector showed
 * "entities · undefined". A new connector type now adds one case here rather
 * than needing an audit of every render site.
 */
export function connectorSubtitle(connector: Connector): string | null {
  switch (connector.type) {
    case 'github':
      return connector.org ?? null;
    case 'kubernetes':
      return connector.cluster?.name ?? null;
    default:
      return null;
  }
}
