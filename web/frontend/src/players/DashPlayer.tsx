import { useEffect, useRef, useState } from "react";
import { proxiedPlaybackUrl } from "../playbackUrls";

interface DashPlayerProps {
  url: string;
  label: string;
}

export default function DashPlayer({ url, label }: DashPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading DASH player...");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let destroyed = false;
    let player: { reset: () => void } | null = null;

    async function start() {
      setError(null);
      setStatus("Connecting...");
      const dashjs = await import("dashjs");
      if (destroyed || !video) {
        return;
      }

      const instance = dashjs.MediaPlayer().create();
      player = instance;
      instance.updateSettings({
        streaming: {
          requestModifier: {
            modifyRequestURL: (requestUrl: string) => proxiedPlaybackUrl(requestUrl),
          },
        },
      });
      instance.initialize(video, proxiedPlaybackUrl(url), true);
      instance.on(dashjs.MediaPlayer.events.ERROR, () => {
        setError("DASH playback failed. Is the stream live and DASH enabled on Zixi?");
      });
      instance.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, () => {
        setStatus("Playing");
      });
    }

    void start();

    return () => {
      destroyed = true;
      player?.reset();
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
