import { useEffect, useRef, useState } from "react";
import { proxiedPlaybackUrl } from "../playbackUrls";

interface MpegTsPlayerProps {
  url: string;
  label: string;
}

export default function MpegTsPlayer({ url, label }: MpegTsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading MPEG-TS player...");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let destroyed = false;
    let player: { destroy: () => void } | null = null;

    async function start() {
      setError(null);
      setStatus("Connecting...");
      const mpegts = await import("mpegts.js");
      if (destroyed) {
        return;
      }
      if (!mpegts.default.isSupported()) {
        setError("MPEG-TS MSE playback is not supported in this browser.");
        return;
      }

      const instance = mpegts.default.createPlayer(
        {
          type: "mse",
          isLive: true,
          url: proxiedPlaybackUrl(url),
        },
        {
          enableWorker: true,
          liveBufferLatencyChasing: true,
        },
      );
      player = instance;
      instance.attachMediaElement(video);
      instance.load();
      instance.play();
      setStatus("Playing");
      instance.on(mpegts.default.Events.ERROR, () => {
        setError("MPEG-TS playback failed. Stream must be actively ingesting.");
      });
    }

    void start();

    return () => {
      destroyed = true;
      player?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [url]);

  return (
    <div className="player-surface">
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay />
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
      </div>
      {error && <p className="player-error">{error}</p>}
    </div>
  );
}
