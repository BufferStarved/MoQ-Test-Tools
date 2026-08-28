import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { resolvePlaybackXhrUrl } from "../playbackFetch";
import type { PlaybackGate } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
import { clockSkewMs } from "../clockSkew";
import { elapsedSecFromStart, usePlaybackMetricsReporter } from "../playbackMetrics";
import { GoLiveButton } from "../GoLiveButton";
import { goLiveHoldSec, latchGoLive, seekGoLive } from "../goLive";
import {
  EMPTY_STARTUP_PHASES,
  findStartupResourceTiming,
  latchStartupPhases,
  startupPhasesFromMilestones,
  type StartupPlayerPhases,
} from "../startupTiming";
import {
  attachHtmlPlaybackMonitors,
  loadJobRebuffer,
  persistJobRebuffer,
  readVideoFrameStats,
} from "../videoPlaybackMetrics";
import { playbackCoveredEncode, stallAgainstEncodeMessage } from "../playbackEndVerdict";

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
  playbackPolicy?: "live-edge" | "complete";
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
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
  playbackPolicy = "live-edge",
  encodeDurationSec = 30,
  encodeElapsedSec,
  runStopped = false,
}: DashPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastErrorRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading DASH player...");
  const rebufferRef = useRef(new RebufferTracker());
  const goLiveRef = useRef({ atSec: 0, e2eMs: 0 });
  const sessionRef = useRef({
    ttffMs: 0,
    liveStartedAtMs: 0,
    maxVideoTime: 0,
    errorCount: 0,
    dashLiveLatencyMs: 0,
    // Startup milestones (epoch ms) for the player-chain decomposition.
    firstMediaAtMs: 0,
    firstPaintAtMs: 0,
  });
  const startupPhasesRef = useRef<StartupPlayerPhases>({ ...EMPTY_STARTUP_PHASES });
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

  /**
   * Player-chain startup phases (see src/startup_budget.py).
   *
   * The MPD's own Resource Timing entry supplies the first two boundaries
   * (`fetchStart → requestStart` = DNS + connect + TLS, `requestStart →
   * responseEnd` = the MPD itself); the media milestones come from dash.js
   * events, which are on the same wall clock. Cross-origin opacity zeroes the
   * interior marks unless the packager sends `Timing-Allow-Origin`, and both
   * Resource-Timing-backed phases then report unmeasured rather than 0 — the
   * MPD here is normally fetched through the app's own proxy, so it is
   * same-origin and visible.
   */
  function startupPhases(): StartupPlayerPhases {
    const session = sessionRef.current;
    const manifest = findStartupResourceTiming(url);
    startupPhasesRef.current = latchStartupPhases(
      startupPhasesRef.current,
      startupPhasesFromMilestones({
        attachAtMs: session.liveStartedAtMs,
        requestSentAtMs: manifest.requestSentAtMs,
        manifestReceivedAtMs: manifest.responseEndAtMs,
        firstMediaAtMs: session.firstMediaAtMs,
        firstPaintAtMs: session.firstPaintAtMs,
      }),
    );
    return startupPhasesRef.current;
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
      go_live_at_sec: goLiveRef.current.atSec,
      go_live_e2e_ms: goLiveRef.current.e2eMs,
      ...startupPhases(),
    };
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
      if (playbackGate === "ended") {
        const painted = sessionRef.current.maxVideoTime > 0.25;
        if (
          painted &&
          (encodeDurationSec || encodeElapsedSec) &&
          !playbackCoveredEncode({
            videoTimeSec: sessionRef.current.maxVideoTime,
            encodeDurationSec,
            encodeElapsedSec,
            runStopped,
          })
        ) {
          const message = stallAgainstEncodeMessage({
            protocolLabel: "DASH",
            videoTimeSec: sessionRef.current.maxVideoTime,
            encodeDurationSec,
            encodeElapsedSec,
            runStopped,
          });
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        } else if (painted) {
          setError(null);
          setStatus("Playback OK");
        } else {
          const message =
            lastErrorRef.current ||
            "DASH never painted. Encode-only is not playback — the MPD 404'd or the packager never cut a segment.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        }
        return;
      }
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
      firstMediaAtMs: 0,
      firstPaintAtMs: 0,
    };
    startupPhasesRef.current = { ...EMPTY_STARTUP_PHASES };
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
          sessionRef.current.firstPaintAtMs = Date.now();
          sessionRef.current.ttffMs = Math.max(
            1,
            Math.round(sessionRef.current.firstPaintAtMs - sessionRef.current.liveStartedAtMs),
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
          liveCatchup:
            lowLatencyMode && playbackPolicy !== "complete"
            ? {
                enabled: true,
                maxDrift: 0.5,
                playbackRate: { min: -0.5, max: 0.5 },
              }
            : { enabled: false, playbackRate: { min: 0, max: 0 } },
          requestModifier: {
            modifyRequestURL: (requestUrl: string) => resolveDashRequestUrl(requestUrl, url),
          },
        },
      } as Parameters<typeof instance.updateSettings>[0]);
      instance.initialize(video, proxied, true);
      instance.on(dashjs.MediaPlayer.events.ERROR, ((e: { error?: { message?: string } }) => {
        if (destroyed) {
          return;
        }
        sessionRef.current.errorCount += 1;
        const message = e?.error?.message || "";
        const played = sessionRef.current.maxVideoTime > 0.25 || sessionRef.current.ttffMs > 0;
        if (played && /404|manifest|MPD/i.test(message)) {
          lastErrorRef.current = null;
          setError(null);
          setStatus("Playback OK");
          return;
        }
        const detail = message ? ` (${message})` : "";
        const shown = lowLatencyMode
          ? `LL-DASH playback failed${detail}. Is MediaMTX live and the LL-DASH packager running?`
          : `DASH playback failed${detail}. Is the stream live and DASH enabled on Zixi?`;
        lastErrorRef.current = shown;
        setError(shown);
      }) as Parameters<typeof instance.on>[1]);
      // First media segment response completed. Anything between the MPD
      // arriving and this instant is the packager still cutting a segment the
      // player can decode — the span the startup decomposition exists to name.
      instance.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, (() => {
        if (!destroyed && sessionRef.current.firstMediaAtMs <= 0) {
          sessionRef.current.firstMediaAtMs = Date.now();
        }
      }) as Parameters<typeof instance.on>[1]);
      instance.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, (() => {
        if (!destroyed) {
          setStatus("Playing");
          if (sessionRef.current.ttffMs <= 0 && sessionRef.current.liveStartedAtMs > 0) {
            sessionRef.current.firstPaintAtMs = Date.now();
            sessionRef.current.ttffMs = Math.max(
              1,
              Math.round(sessionRef.current.firstPaintAtMs - sessionRef.current.liveStartedAtMs),
            );
          }
        }
      }) as Parameters<typeof instance.on>[1]);
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

  return (
    <div className="player-surface">
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay />
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
        <GoLiveButton
          visible
          disabled={playbackGate !== "live"}
          onGoLive={() => {
            const e2e = captureAnchoredE2eMs();
            const elapsed = elapsedSecFromStart(encodeStartedAtEpoch);
            goLiveRef.current = latchGoLive(goLiveRef.current, elapsed, e2e);
            const result = seekGoLive(videoRef.current, goLiveHoldSec("dash"));
            setStatus(result.ok ? "Playing (live)" : status);
          }}
        />
      </div>
      {error && <p className="player-error">{error}</p>}
    </div>
  );
}
