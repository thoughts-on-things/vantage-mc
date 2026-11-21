import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ArrowLeft, Copy, RotateCcw, TriangleAlert } from 'lucide-react';

interface Props {
  /** What stopped working, e.g. "The map viewer". */
  scope: string;
  /** Leaves the broken screen. Without it the action reloads the window. */
  onExit?: () => void;
  exitLabel?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render-time crash below it and shows what failed.
 *
 * Without a boundary React unmounts the whole tree on an uncaught render
 * error, which in a native window reads as an empty black screen with nothing
 * to report.
 */
export class CrashBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.scope} crashed:`, error, info.componentStack);
  }

  private exit = () => {
    if (this.props.onExit) {
      this.setState({ error: null });
      this.props.onExit();
    } else {
      window.location.reload();
    }
  };

  private copy = (error: Error) => {
    const details = `${this.props.scope} crashed: ${error.message}\n\n${error.stack ?? ''}`;
    void navigator.clipboard?.writeText(details).catch(() => undefined);
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onExit, exitLabel, scope } = this.props;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card glass-panel">
          <TriangleAlert className="crash-icon" size={22} aria-hidden="true" />
          <h1>{scope} stopped working</h1>
          <p>Vantage hit an error it could not recover from. Your world and renders are untouched.</p>
          <pre>{error.message || error.name}</pre>
          <div className="crash-actions">
            <button className="primary-button compact" onClick={this.exit}>
              {onExit ? <ArrowLeft size={15} /> : <RotateCcw size={15} />}
              {exitLabel ?? (onExit ? 'Back' : 'Reload Vantage')}
            </button>
            <button onClick={() => this.copy(error)}>
              <Copy size={15} /> Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
