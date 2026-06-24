import type { Connector } from '@/lib/api';

// Single source of truth for "how do we render a source connector in the
// UI?". Used by the catalog table, graph explorer, entity detail page, and
// global search dropdown so the same entity surfaces a consistent pill
// everywhere.
export interface ConnectorIdentity {
  type: string; // 'github' | 'kubernetes' | ...
  connectorId: string | null; // 'gh-acme-prod'; null for nodes that pre-date the field
  displayName: string; // 'GitHub · acme-prod' (or 'GitHub' when instance is unknown)
  shortName: string; // 'acme-prod' (or 'GitHub' fallback); used inside narrow chips
  // Whether we found a matching connector in the /api/connectors list. False
  // means the connector has been deleted from config or the node was written
  // before _source_connector_id existed — the caller can dim/grey the pill.
  resolved: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  github: 'GitHub',
  kubernetes: 'Kubernetes',
};

function titleCaseType(type: string | undefined): string {
  if (!type) return 'Unknown';
  return TYPE_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Joins a node's `_source_system` + `_source_connector_id` against the
 * `/api/connectors` list so the UI can render the connector's friendly
 * `name` rather than its raw ID. Pure — `connectors` may be `undefined`
 * while the list is still loading; we degrade gracefully.
 */
export function resolveConnectorIdentity(
  sourceSystem: string | undefined,
  sourceConnectorId: string | undefined | null,
  connectors: Connector[] | undefined,
): ConnectorIdentity {
  const type = sourceSystem ?? 'unknown';
  const typeLabel = titleCaseType(sourceSystem);
  const connectorIdValue =
    sourceConnectorId === null || sourceConnectorId === undefined || sourceConnectorId === ''
      ? null
      : sourceConnectorId;

  if (!connectorIdValue) {
    // Forward-only migration: nodes written before the field existed only
    // carry `_source_system`. Show the type alone so the user still sees
    // *something*.
    return {
      type,
      connectorId: null,
      displayName: typeLabel,
      shortName: typeLabel,
      resolved: false,
    };
  }

  const match = connectors?.find((c) => c.id === connectorIdValue);
  if (!match) {
    // Connector instance was deleted (or the list hasn't loaded). Surface
    // the raw ID so the user can still match it against config.
    return {
      type,
      connectorId: connectorIdValue,
      displayName: `${typeLabel} · ${connectorIdValue}`,
      shortName: connectorIdValue,
      resolved: false,
    };
  }

  // The connector's `name` is the human-edited label from the wizard;
  // fall back to its ID if blank.
  const name = match.name?.trim() || match.id;
  return {
    type,
    connectorId: connectorIdValue,
    displayName: `${typeLabel} · ${name}`,
    shortName: name,
    resolved: true,
  };
}

/**
 * Stable string key for filter facets. Format: `${type}:${connectorId}` for
 * a specific instance, `${type}:*` for "any instance of this type", and
 * `unknown` for nodes that have no source at all.
 */
export function connectorIdentityKey(
  sourceSystem: string | undefined,
  sourceConnectorId: string | undefined | null,
): string {
  if (!sourceSystem) return 'unknown';
  if (!sourceConnectorId) return `${sourceSystem}:*`;
  return `${sourceSystem}:${sourceConnectorId}`;
}
