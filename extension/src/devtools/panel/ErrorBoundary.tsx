import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Keeps one broken pane from taking the whole panel with it.
 *
 * Worth having here specifically: the panel renders data it does not own —
 * HAR entries from Chrome, a workspace that may have been written by another
 * build or by an agent over MCP — and React unmounts the entire tree on an
 * unhandled render error. Without this, one malformed record turns the panel
 * into a blank rectangle with no clue as to why.
 *
 * The fallback names the failing area and shows the message, so a bug report can
 * be made from what is on screen rather than from a DevTools-on-DevTools console.
 */
export class ErrorBoundary extends Component<
  { area: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The panel has its own console, separate from the inspected page's.
    console.error(`[mockman] ${this.props.area} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="boundary">
        <strong>The {this.props.area} hit a problem.</strong>
        <code>{error.message}</code>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
