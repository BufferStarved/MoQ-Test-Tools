import { Component, type ErrorInfo, type ReactNode } from "react";

interface PlayerErrorBoundaryProps {
  engine: string;
  children: ReactNode;
}

interface PlayerErrorBoundaryState {
  error: Error | null;
}

export class PlayerErrorBoundary extends Component<
  PlayerErrorBoundaryProps,
  PlayerErrorBoundaryState
> {
  state: PlayerErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PlayerErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.engine} player]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="player-surface player-error">
          <p>
            <strong>{this.props.engine.toUpperCase()} player crashed:</strong>{" "}
            {this.state.error.message}
          </p>
          <p className="hint">Other streams and charts should keep working. Check DevTools console for details.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
