import { Component, type ErrorInfo, type ReactNode } from "react";

interface ResultsErrorBoundaryProps {
  children: ReactNode;
  /** Short name for the pane that crashed (charts, scorecard). */
  label?: string;
}

interface ResultsErrorBoundaryState {
  error: Error | null;
}

/** Keep a chart or scorecard throw from unmounting the whole Results tab. */
export class ResultsErrorBoundary extends Component<
  ResultsErrorBoundaryProps,
  ResultsErrorBoundaryState
> {
  state: ResultsErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ResultsErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[results ${this.props.label ?? "pane"}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="results-crash" role="alert">
          <p>
            <strong>This {this.props.label ?? "results"} pane crashed</strong> on a
            partial session. The rest of the page stays up.
          </p>
          <p className="hint">{this.state.error.message}</p>
          <button
            type="button"
            className="player-error-reload"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
