import { useEffect, useRef, useState } from "react";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { resolvePlaybackXhrUrl } from "../playbackFetch";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";

interface DashPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  /** Enable dash.js low-latency live mode (CMAF LL-DASH). */
  lowLatencyMode?: boolean;
}

/**
 * dash.js resolves relative SegmentTemplate URLs against the MPD request URL.
 * When the MPD is loaded via /api/playback/fetch?url=..., relative segments must
 * be rewritten back onto the upstream origin and re-proxied.
 */
function resolveDashRequestUrl(requestUrl: string, manifestRemoteUrl: string): string {
  try {
    const parsed = new URL(requestUrl, window.location.origin);
    const path = parsed.pathname;
    if (path.endsWith("/playback.m4s") || path.endsWith("playback.m4s")) {
      const origin = new URL(manifestRemoteUrl).origin;
      return proxiedPlaybackUrl(`${origin}/playback.m4s${parsed.search}`);
    }
  } catch {
    /* fall through */
  }
  try {
    const absolute = new URL(requestUrl, manifestRemoteUrl).href;
    return resolvePlaybackXhrUrl(absolute);
  } catch {
    return resolvePlaybackXhrUrl(requestUrl);
  }
}

export default function DashPlayer({
  url,
  label,
  playbackGate = "live",
  lowLatencyMode = false,
}: DashPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading DASH player...");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (playbackGate !== "live") {
      setError(null);
      setStatus(
        playbackGate === "waiting" ? "Waiting for live DASH..." : "Waiting for encode...",
      );
      return;
    }

    let destroyed = false;
    let player: { reset: () => void } | null = null;

    async function start() {
      setError(null);
      setStatus(lowLatencyMode ? "Connecting (LL-DASH)..." : "Connecting...");
      const proxied = proxiedPlaybackUrl(url);
      try {
        const probe = await fetch(proxied, { cache: "no-store" });
        if (!probe.ok) {
          if (!destroyed) {
            setStatus("DASH manifest missing");
            setError(
              lowLatencyMode
                ? `LL-DASH manifest HTTP ${probe.status}. Is the MediaMTX LL-DASH packager running on :8891?`
                : `DASH manifest HTTP ${probe.status}. Zixi per-input MPD needs an adaptive group — use HLS or MPEG-TS playback.`,
            );
          }
          return;
        }
      } catch (err) {
        if (!destroyed) {
          setStatus("DASH manifest unreachable");
          setError(err instanceof Error ? err.message : "Failed to fetch DASH manifest");
        }
        return;
      }
      const dashjs = await import("dashjs");
      if (destroyed || !video) {
        return;
      }

      const instance = dashjs.MediaPlayer().create();
      player = instance;
      instance.updateSettings({
        streaming: {
          delay: lowLatencyMode
            ? {
                liveDelay: 2,
                liveCatchup: {
                  enabled: true,
                  maxDrift: 0.5,
                  playbackRate: { min: -0.5, max: 0.5 },
                },
              }
            : undefined,
          lowLatencyEnabled: lowLatencyMode,
          liveCatchup: lowLatencyMode
            ? {
                enabled: true,
                maxDrift: 0.5,
                playbackRate: { min: -0.5, max: 0.5 },
              }
            : undefined,
          requestModifier: {
            modifyRequestURL: (requestUrl: string) => resolveDashRequestUrl(requestUrl, url),
          },
        },
      });
      instance.initialize(video, proxied, true);
      instance.on(dashjs.MediaPlayer.events.ERROR, (e: { error?: { message?: string } }) => {
        if (!destroyed) {
          const detail = e?.error?.message ? ` (${e.error.message})` : "";
          setError(
            lowLatencyMode
              ? `LL-DASH playback failed${detail}. Is MediaMTX live and the LL-DASH packager running?`
              : `DASH playback failed${detail}. Is the stream live and DASH enabled on Zixi?`,
          );
        }
      });
      instance.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, () => {
        if (!destroyed) {
          setStatus("Playing");
        }
      });
    }

    void start();

    return () => {
      destroyed = true;
      player?.reset();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, playbackGate, lowLatencyMode]);

  const gateMessage =
    playbackGate !== "live" ? playbackGateLabel(playbackGate, "other") : null;

  return (
    <div className="player-surface">
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay />
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
      </div>
      {gateMessage && <p className="hint player-note">{gateMessage}</p>}
      {error && <p className="player-error">{error}</p>}
    </div>
  );
}
