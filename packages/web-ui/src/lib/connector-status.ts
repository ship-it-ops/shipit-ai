import type { StatusState, BadgeProps } from '@ship-it-ui/ui';
import type { ConnectorInfo } from './api';

// The one place a ConnectorInfo status becomes words and colour. The card
// (StatusDot) and the detail drawer (Badge) both read from here, so the two
// surfaces cannot disagree about the same connector again — that is how
// "degraded" ended up printed next to a card that said "Syncing".
export interface ConnectorStatusPresentation {
  label: string;
  dot: StatusState;
  badge: BadgeProps['variant'];
  /** Animate the dot — only while a run is actually in flight. */
  pulse: boolean;
}

export const CONNECTOR_STATUS: Record<ConnectorInfo['status'], ConnectorStatusPresentation> = {
  healthy: { label: 'Connected', dot: 'ok', badge: 'ok', pulse: false },
  syncing: { label: 'Syncing', dot: 'sync', badge: 'accent', pulse: true },
  pending: { label: 'Waiting for first sync', dot: 'sync', badge: 'neutral', pulse: false },
  degraded: { label: 'Degraded', dot: 'warn', badge: 'warn', pulse: false },
  failed: { label: 'Error', dot: 'err', badge: 'err', pulse: false },
  not_connected: { label: 'Disconnected', dot: 'off', badge: 'neutral', pulse: false },
};
