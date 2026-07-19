import type { PlaybackTarget } from "../playbackTypes";

interface UnsupportedPlaybackProps {
  target: PlaybackTarget;
}

export default function UnsupportedPlayback({ target }: UnsupportedPlaybackProps) {
  return (
    <div className="player-surface player-unsupported">
      <p>
        <strong>{target.label}</strong> cannot be played in this panel.
      </p>
      {target.note && <p className="hint">{target.note}</p>}
      {target.url && (
        <p className="hint">
          <a className="player-link" href={target.url} target="_blank" rel="noreferrer">
            Open externally
          </a>
          {" · "}
          <code>{target.url}</code>
        </p>
      )}
    </div>
  );
}
