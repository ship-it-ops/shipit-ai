'use client';

import { Component, type ReactNode } from 'react';
import { Card } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';

interface Props {
  /** Title shown when this panel fails — usually the panel's own card title. */
  title: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-panel error boundary. Next.js's `error.tsx` is page-level and would
 * blank the whole dashboard if any one panel threw — that's the worst
 * possible outcome during an active incident. Wrap each panel here so a
 * single bad panel degrades to a tiny error card while the rest of the
 * dashboard keeps rendering.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Surface to the browser console so the IC's devtools tab catches it,
    // and Sentry/equivalent will pick it up via window.onerror equivalents.
    // eslint-disable-next-line no-console
    console.error(`[IncidentPanel: ${this.props.title}]`, error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Card title={this.props.title}>
          <div className="text-err flex items-start gap-2 text-[12px]">
            <IconGlyph name="warn" size={14} />
            <div className="flex flex-col gap-1">
              <span className="font-medium">Panel failed to render.</span>
              <span className="text-text-muted">
                Other panels are unaffected. Refresh to retry.
              </span>
              <code className="text-text-dim mt-1 font-mono text-[10px]">
                {this.state.error.message}
              </code>
            </div>
          </div>
        </Card>
      );
    }
    return this.props.children;
  }
}
