import { useEffect, useRef, useState } from "react";
import { WebRTCPlayer } from "@eyevinn/webrtc-player";

interface WhepPlayerProps {
  url: string;
  label: string;
}

export default function WhepPlayer({ url, label }: WhepPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<WebRTCPlayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting WHEP...");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let destroyed = false;
    const player = new WebRTCPlayer({
      video,
      type: "whep",
      statsTypeFilter: "^candidate-*|^inbound-rtp",
    });
    playerRef.current = player;

    player.on("no-media", () => {
      setStatus("Waiting for media...");
    });
    player.on("media-recovered", () => {
      setStatus("Playing");
      setError(null);
    });

    async function start() {
      try {
        setError(null);
        setStatus("Connecting...");
        await player.load(new URL(url));
        if (destroyed) {
          return;
        }
        player.unmute();
        setStatus("Playing");
      } catch (err) {
        if (!destroyed) {
          setError(
            err instanceof Error
              ? err.message
              : "WHEP connection failed. Is the WHEP gateway running and the stream live?",
          );
          setStatus("Failed");
        }
      }
    }

    void start();

    return () => {
      destroyed = true;
      player.destroy();
      playerRef.current = null;
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
