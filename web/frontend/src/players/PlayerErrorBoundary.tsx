import { Component, type ErrorInfo, type ReactNode } from "react";

interface PlayerErrorBoundaryProps {
  engine: string;
  children: ReactNode;
}

interface PlayerErrorBoundaryState {
  error: Error | null;
}

// Chrome/Firefox/Safari all phrase this differently, but it's always the
// same root cause: a lazy(() => import(...)) chunk (e.g. MoqPlayer-<hash>.js)
// that was fine when this tab first loaded no longer exists on disk because
// the server was redeployed since — normal Vite content-hashed build output,
// not a real player bug. Confirmed live 2026-07-20: user's tab, open across
// a deploy, 404'd fetching a stale MoqPlayer-<oldhash>.js.
const STALE_CHUNK_ERROR_RE =
  /fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

function isStaleChunkError(error: Error): boolean {
  return STALE_CHUNK_ERROR_RE.test(error.message);
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
      if (isStaleChunkError(this.state.error)) {
        return (
          <div className="player-surface player-error">
            <p>
              <strong>A new version of this app was deployed</strong> while this tab was open.
            </p>
            <p className="hint">
              Reload to get the current version. Other streams and charts keep working until you do.
            </p>
            <button type="button" className="player-error-reload" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        );
      }
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
