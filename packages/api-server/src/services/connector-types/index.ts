import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { githubConnectorType } from './github.js';
import type { ConnectorType } from './types.js';

export type {
  BuildContext,
  BuildResult,
  BuiltConnector,
  ConnectorType,
  ProbeResult,
} from './types.js';

// Every connector kind the api-server can run. Adding a connector = adding a
// module here; the scheduler, registry and routes dispatch through this table.
// `ConnectorType<Specific>` is not assignable to `ConnectorType<Union>` (build's
// parameter is contravariant), so entries are widened once, here.
export const CONNECTOR_TYPES: Readonly<Record<string, ConnectorType>> = {
  github: githubConnectorType as unknown as ConnectorType,
};

export function getConnectorType(type: string): ConnectorType | undefined {
  return CONNECTOR_TYPES[type];
}

export function connectorTypeFor(cfg: ConnectorInstanceConfig): ConnectorType {
  const type = CONNECTOR_TYPES[cfg.type];
  if (!type) throw new Error(`No connector type registered for "${cfg.type}"`);
  return type;
}
