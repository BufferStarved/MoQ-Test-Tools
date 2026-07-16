interface ZixiWebRtcEmbedProps {
  embedUrl: string;
  label: string;
}

export default function ZixiWebRtcEmbed({ embedUrl, label }: ZixiWebRtcEmbedProps) {
  return (
    <div className="player-surface player-embed-surface">
      <p className="hint player-note">
        Zixi WebRTC requires logging in at{" "}
        <a href={embedUrl.replace(/webrtc\.html.*/, "login.html")} target="_blank" rel="noreferrer">
          Zixi UI
        </a>{" "}
        in this browser first. If the iframe is blank, use playback mode HLS or fix Zixi HLS output.
      </p>
      <iframe
        className="player-embed"
        src={embedUrl}
        title={label}
        allow="autoplay; fullscreen; microphone; camera"
        referrerPolicy="no-referrer"
      />
      <div className="player-meta">
        <span>{label}</span>
        <a className="player-link" href={embedUrl} target="_blank" rel="noreferrer">
          Open Zixi player
        </a>
      </div>
    </div>
  );
}
