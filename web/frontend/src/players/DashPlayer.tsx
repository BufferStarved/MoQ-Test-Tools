import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { resolvePlaybackXhrUrl } from "../playbackFetch";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
import { clockSkewMs } from "../clockSkew";
import { usePlaybackMetricsReporter } from "../playbackMetrics";
import {
  attachHtmlPlaybackMonitors,
  loadJobRebuffer,
  persistJobRebuffer,
  readVideoFrameStats,
} from "../videoPlaybackMetrics";

interface DashPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  /** Enable dash.js low-latency live mode (CMAF LL-DASH). */
  lowLatencyMode?: boolean;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  bridgeLagMs?: number;
  encoderLagMs?: number;
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
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  bridgeLagMs = 0,
  encoderLagMs = 0,
}: DashPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading DASH player...");
  const rebufferRef = useRef(new RebufferTracker());
  const sessionRef = useRef({
    ttffMs: 0,
    liveStartedAtMs: 0,
    maxVideoTime: 0,
    errorCount: 0,
    dashLiveLatencyMs: 0,
  });
  const lagRef = useRef({ bridgeMs: 0, encoderMs: 0, epoch: 0 });
  lagRef.current = {
    bridgeMs: bridgeLagMs,
    encoderMs: encoderLagMs,
    epoch: encodeStartedAtEpoch ?? 0,
  };
  const liveLatencyRef = useRef<(() => number) | null>(null);

  function captureAnchoredE2eMs(): number | undefined {
    const { bridgeMs, epoch } = lagRef.current;
    // Prefer dash.js live latency when LL-DASH reports it (packager→glass).
    const dashLive = sessionRef.current.dashLiveLatencyMs;
    if (lowLatencyMode && dashLive > 0) {
      const total = dashLive + bridgeMs;
      return total > 0 && total < 120_000 ? Math.round(total) : undefined;
    }
    if (epoch > 0 && sessionRef.current.maxVideoTime > 0.25) {
      const total =
        Date.now() + clockSkewMs() - epoch * 1000 - sessionRef.current.maxVideoTime * 1000 + bridgeMs;
      return total > 0 && total < 120_000 ? Math.round(total) : undefined;
    }
    return undefined;
  }

  const getPlaybackSnapshot = useCallback((): PlaybackMetricsSnapshot => {
    const frames = readVideoFrameStats(videoRef.current);
    const getter = liveLatencyRef.current;
    if (getter) {
      try {
        const sec = getter();
        if (Number.isFinite(sec) && sec > 0) {
          sessionRef.current.dashLiveLatencyMs = Math.round(sec * 1000);
        }
      } catch {
        /* player torn down */
      }
    }
    persistJobRebuffer(jobId, rebufferRef.current);
    return {
      playback_stats_events: frames.framesRendered > 0 ? 1 : 0,
      playback_stall_count: rebufferRef.current.stallCount,
      playback_frames_rendered: frames.framesRendered,
      playback_frames_dropped: frames.framesDropped,
      playback_bitrate_bps: 0,
      playback_ttff_ms: sessionRef.current.ttffMs,
      playback_hls_errors: sessionRef.current.errorCount,
      playback_hls_fatal_errors: 0,
      playback_hls_buffer_stalls: 0,
      playback_hls_frag_loads: 0,
      playback_video_time_sec: sessionRef.current.maxVideoTime,
      playback_buffer_sec: bufferedAheadSec(videoRef.current),
      playback_rebuffer_sec: rebufferRef.current.totalSec,
      e2e_latency_ms: captureAnchoredE2eMs(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  usePlaybackMetricsReporter({
    jobId,
    engine: "dash",
    enabled: playbackGate === "live",
    startedAtEpoch: encodeStartedAtEpoch,
    getSnapshot: getPlaybackSnapshot,
    onSample: onPlaybackSample,
  });

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
    let player: { reset: () => void; getCurrentLiveLatency?: () => number } | null = null;
    let detachHtmlMonitors: (() => void) | undefined;
    sessionRef.current = {
      ttffMs: 0,
      liveStartedAtMs: Date.now(),
      maxVideoTime: 0,
      errorCount: 0,
      dashLiveLatencyMs: 0,
    };
    rebufferRef.current.reset();
    loadJobRebuffer(jobId, rebufferRef.current);

    const onTimeUpdate = () => {
      if (destroyed) {
        return;
      }
      const vt = video.currentTime;
      if (vt > 0.05) {
        sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, vt);
        if (sessionRef.current.ttffMs <= 0 && sessionRef.current.liveStartedAtMs > 0) {
          sessionRef.current.ttffMs = Math.max(
            1,
            Math.round(Date.now() - sessionRef.current.liveStartedAtMs),
          );
        }
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    detachHtmlMonitors = attachHtmlPlaybackMonitors(video, {
      rebuffer: rebufferRef.current,
      hasPlayedOnce: () => sessionRef.current.ttffMs > 0,
    });

    async function start() {
      setError(null);
      setStatus(lowLatencyMode ? "Connecting (LL-DASH)..." : "Connecting...");
      const proxied = proxiedPlaybackUrl(url);
      const pollDeadline = Date.now() + 60_000;
      let probeOk = false;
      while (!destroyed && Date.now() < pollDeadline) {
        try {
          const probe = await fetch(proxied, { cache: "no-store" });
          if (probe.ok) {
            probeOk = true;
            break;
          }
          if (!destroyed) {
            setStatus(`Waiting for DASH manifest (HTTP ${probe.status})...`);
          }
        } catch (err) {
          if (!destroyed) {
            setStatus(
              err instanceof Error
                ? `Waiting for DASH manifest (${err.message})...`
                : "Waiting for DASH manifest...",
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (destroyed) {
        return;
      }
      if (!probeOk) {
        setStatus("DASH manifest missing");
        setError(
          lowLatencyMode
            ? "LL-DASH manifest never became ready (packager on :8891). Check moq-mediamtx-lldash."
            : "DASH manifest HTTP missing. Zixi per-input MPD needs an adaptive group — use HLS or MPEG-TS playback.",
        );
        sessionRef.current.errorCount += 1;
        return;
      }
      const dashjs = await import("dashjs");
      if (destroyed || !video) {
        return;
      }

      const instance = dashjs.MediaPlayer().create();
      player = instance;
      liveLatencyRef.current = () => instance.getCurrentLiveLatency();
      instance.updateSettings({
        streaming: {
          delay: lowLatencyMode ? { liveDelay: 2 } : undefined,
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
      } as Parameters<typeof instance.updateSettings>[0]);
      instance.initialize(video, proxied, true);
      instance.on(dashjs.MediaPlayer.events.ERROR, ((e: { error?: { message?: string } }) => {
        if (!destroyed) {
          sessionRef.current.errorCount += 1;
          const detail = e?.error?.message ? ` (${e.error.message})` : "";
          setError(
            lowLatencyMode
              ? `LL-DASH playback failed${detail}. Is MediaMTX live and the LL-DASH packager running?`
              : `DASH playback failed${detail}. Is the stream live and DASH enabled on Zixi?`,
          );
        }
      }) as (e: Event) => void);
      instance.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, (() => {
        if (!destroyed) {
          setStatus("Playing");
          if (sessionRef.current.ttffMs <= 0 && sessionRef.current.liveStartedAtMs > 0) {
            sessionRef.current.ttffMs = Math.max(
              1,
              Math.round(Date.now() - sessionRef.current.liveStartedAtMs),
            );
          }
        }
      }) as (e: Event) => void);
    }

    void start();

    return () => {
      destroyed = true;
      persistJobRebuffer(jobId, rebufferRef.current);
      detachHtmlMonitors?.();
      liveLatencyRef.current = null;
      video.removeEventListener("timeupdate", onTimeUpdate);
      player?.reset();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, playbackGate, lowLatencyMode, jobId]);

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
