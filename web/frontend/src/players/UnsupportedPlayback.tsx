import type { PlaybackTarget } from "../playbackTypes";

interface UnsupportedPlaybackProps {
  target: PlaybackTarget;
}

export default function UnsupportedPlayback({ target }: UnsupportedPlaybackProps) {
  return (
    <div className="player-surface player-unsupported">
      <p>
        <strong>{target.label}</strong> cannot be played directly in the browser.
      </p>
      {target.note && <p className="hint">{target.note}</p>}
      {target.url && (
        <p className="hint">
          Manifest: <code>{target.url}</code>
        </p>
      )}
    </div>
  );
}
