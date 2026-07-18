import { useEffect, useRef, useState } from "react";
import { proxiedPlaybackUrl } from "../playbackUrls";

interface MpegTsPlayerProps {
  url: string;
  label: string;
}

/** Max automatic reconnects after the Zixi HTTP-TS session ends on republish. */
const MAX_RECONNECTS = 8;
const RECONNECT_DELAY_MS = 1200;

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
    let player: { destroy: () => void; unload?: () => void; detachMediaElement?: () => void } | null =
      null;
    let reconnectTimer: number | null = null;
    let reconnects = 0;
    let mpegtsMod: typeof import("mpegts.js") | null = null;

    const clearReconnect = () => {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const destroyPlayer = () => {
      if (!player) {
        return;
      }
      try {
        player.unload?.();
        player.detachMediaElement?.();
        player.destroy();
      } catch {
        // ignore teardown races
      }
      player = null;
    };

    const scheduleReconnect = (reason: string) => {
      if (destroyed) {
        return;
      }
      if (reconnects >= MAX_RECONNECTS) {
        setError(`MPEG-TS playback stopped (${reason}). Refresh or restart the publish.`);
        setStatus("Stopped");
        return;
      }
      reconnects += 1;
      setError(null);
      setStatus(`Reconnecting (${reconnects}/${MAX_RECONNECTS})…`);
      clearReconnect();
      reconnectTimer = window.setTimeout(() => {
        void start();
      }, RECONNECT_DELAY_MS);
    };

    async function start() {
      if (destroyed || !video) {
        return;
      }
      destroyPlayer();
      setError(null);
      setStatus(reconnects > 0 ? "Reconnecting…" : "Connecting…");
      try {
        mpegtsMod = mpegtsMod ?? (await import("mpegts.js"));
      } catch {
        setError("Failed to load mpegts.js");
        return;
      }
      if (destroyed) {
        return;
      }
      const mpegts = mpegtsMod.default;
      if (!mpegts.isSupported()) {
        setError("MPEG-TS MSE playback is not supported in this browser.");
        return;
      }

      const instance = mpegts.createPlayer(
        {
          type: "mse",
          isLive: true,
          url: proxiedPlaybackUrl(url),
        },
        {
          enableWorker: true,
          liveBufferLatencyChasing: true,
          enableStashBuffer: false,
          autoCleanupSourceBuffer: true,
        },
      );
      player = instance;
      instance.attachMediaElement(video);
      instance.load();
      void instance.play().catch(() => {
        /* autoplay may be blocked; controls remain */
      });
      setStatus("Playing (HTTP-TS)");

      instance.on(mpegts.Events.ERROR, (_type: string, _detail: string, info: { code?: number }) => {
        if (destroyed) {
          return;
        }
        destroyPlayer();
        scheduleReconnect(info?.code != null ? `error ${info.code}` : "stream error");
      });
      instance.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (destroyed) {
          return;
        }
        // Live HTTP-TS ends cleanly when the publisher disconnects — re-pull.
        destroyPlayer();
        scheduleReconnect("publisher session ended");
      });
    }

    void start();

    return () => {
      destroyed = true;
      clearReconnect();
      destroyPlayer();
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
