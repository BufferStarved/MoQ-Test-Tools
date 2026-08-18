import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
import { usePlaybackMetricsReporter } from "../playbackMetrics";
import {
  attachHtmlPlaybackMonitors,
  loadJobRebuffer,
  persistJobRebuffer,
  readVideoFrameStats,
} from "../videoPlaybackMetrics";
import { isPlausibleE2eMs, pathDelayMs } from "../glassLatency";
import { isGracefulWhepDisconnect, unwrapFastApiDetail } from "../playbackEos";
import { startWhepSession, waitForWhepIceTerminal, waitForWhepMedia, type WhepSession } from "../whepSession";

interface WhepPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  bridgeLagMs?: number;
  encoderLagMs?: number;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
}

const whepJitterState = new WeakMap<RTCPeerConnection, { delay: number; emitted: number }>();

async function whepViewerLatencyMs(
  pc: RTCPeerConnection | null | undefined,
): Promise<{ jitterBufferMs: number; rttMs: number } | null> {
  if (!pc) {
    return null;
  }
  try {
    const report = await pc.getStats();
    let jitterBufferMs = 0;
    let rttMs = 0;
    report.forEach((stat) => {
      if (stat.type === "inbound-rtp" && stat.kind === "video") {
        const inbound = stat as RTCInboundRtpStreamStats;
        const delay = inbound.jitterBufferDelay;
        const emitted = inbound.jitterBufferEmittedCount;
        if (typeof delay === "number" && typeof emitted === "number" && emitted > 0) {
          const prev = whepJitterState.get(pc);
          const dDelay = prev ? delay - prev.delay : delay;
          const dEmitted = prev ? emitted - prev.emitted : emitted;
          whepJitterState.set(pc, { delay, emitted });
          if (dEmitted > 0) {
            jitterBufferMs = (dDelay / dEmitted) * 1000;
          } else {
            jitterBufferMs = (delay / emitted) * 1000;
          }
        }
      }
      if (stat.type === "candidate-pair" && (stat as RTCIceCandidatePairStats).state === "succeeded") {
        const rtt = (stat as RTCIceCandidatePairStats).currentRoundTripTime;
        if (typeof rtt === "number" && rtt > 0) {
          rttMs = rtt * 1000;
        }
      }
    });
    return { jitterBufferMs, rttMs };
  } catch {
    return null;
  }
}

export default function WhepPlayer({
  url,
  label,
  playbackGate = "live",
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  jobStatus,
  benchmarkLoading = true,
  encodeDurationSec = 30,
}: WhepPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRefHandle = useRef<WhepSession | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting WHEP...");
  const rebufferRef = useRef(new RebufferTracker());
  const sessionRef = useRef({
    ttffMs: 0,
    liveStartedAtMs: 0,
    maxVideoTime: 0,
    errorCount: 0,
    viewerLatencyMs: 0,
    bitrateBps: 0,
    rttMs: 0,
  });
  const lagRef = useRef({ bridgeMs: 0, encoderMs: 0 });
  lagRef.current = { bridgeMs: bridgeLagMs, encoderMs: encoderLagMs };
  const jobStatusRef = useRef(jobStatus);
  jobStatusRef.current = jobStatus;
  const loadingRef = useRef(benchmarkLoading);
  loadingRef.current = benchmarkLoading;
  const encodeDurationRef = useRef(encodeDurationSec);
  encodeDurationRef.current = encodeDurationSec;

  const getPlaybackSnapshot = useCallback((): PlaybackMetricsSnapshot => {
    const frames = readVideoFrameStats(videoRef.current);
    persistJobRebuffer(jobId, rebufferRef.current);
    const { bridgeMs, encoderMs } = lagRef.current;
    const e2e = pathDelayMs({
      encodeLagMs: encoderMs,
      rttMs: sessionRef.current.rttMs,
      playerBufferMs: sessionRef.current.viewerLatencyMs + bridgeMs,
    });
    return {
      playback_stats_events: frames.framesRendered > 0 ? 1 : 0,
      playback_stall_count: rebufferRef.current.stallCount,
      playback_frames_rendered: frames.framesRendered,
      playback_frames_dropped: frames.framesDropped,
      playback_bitrate_bps: sessionRef.current.bitrateBps,
      playback_ttff_ms: sessionRef.current.ttffMs,
      playback_hls_errors: sessionRef.current.errorCount,
      playback_hls_fatal_errors: 0,
      playback_hls_buffer_stalls: 0,
      playback_hls_frag_loads: 0,
      playback_video_time_sec: sessionRef.current.maxVideoTime,
      playback_buffer_sec: bufferedAheadSec(videoRef.current),
      playback_rebuffer_sec: rebufferRef.current.totalSec,
      e2e_latency_ms: e2e && isPlausibleE2eMs(e2e) ? e2e : undefined,
    };
  }, [jobId]);

  usePlaybackMetricsReporter({
    jobId,
    engine: "whep",
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
        playbackGate === "waiting" ? "Waiting…" : playbackGateLabel(playbackGate, "other"),
      );
      return;
    }

    let destroyed = false;
    const abort = new AbortController();
    let detachHtmlMonitors: (() => void) | undefined;
    let statsTimer: number | null = null;
    let lastInboundBytes = 0;
    let lastInboundAt = 0;
    sessionRef.current = {
      ttffMs: 0,
      liveStartedAtMs: Date.now(),
      maxVideoTime: 0,
      errorCount: 0,
      viewerLatencyMs: 0,
      bitrateBps: 0,
      rttMs: 0,
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

    const clearStatsTimer = () => {
      if (statsTimer != null) {
        window.clearInterval(statsTimer);
        statsTimer = null;
      }
    };

    const startStatsTimer = () => {
      clearStatsTimer();
      lastInboundBytes = 0;
      lastInboundAt = 0;
      statsTimer = window.setInterval(() => {
        void whepViewerLatencyMs(pcRef.current).then((sample) => {
          if (sample != null && !destroyed) {
            sessionRef.current.viewerLatencyMs = sample.jitterBufferMs;
            if (sample.rttMs > 0) {
              sessionRef.current.rttMs = sample.rttMs;
            }
          }
        });
        const pc = pcRef.current;
        if (!pc) {
          return;
        }
        void pc.getStats().then((report) => {
          let bytes = 0;
          report.forEach((stat) => {
            if (stat.type !== "inbound-rtp") {
              return;
            }
            const inbound = stat as RTCInboundRtpStreamStats;
            if (inbound.kind === "audio") {
              return;
            }
            const received = inbound.bytesReceived ?? 0;
            if (received >= bytes) {
              bytes = received;
            }
          });
          const now = performance.now();
          if (lastInboundAt > 0 && bytes >= lastInboundBytes) {
            const dt = (now - lastInboundAt) / 1000;
            if (dt > 0) {
              sessionRef.current.bitrateBps = ((bytes - lastInboundBytes) * 8) / dt;
            }
          }
          lastInboundBytes = bytes;
          lastInboundAt = now;
        });
      }, 1000);
    };

    async function start() {
      while (!destroyed) {
        try {
          setError(null);
          setStatus("Connecting...");
          const session = await startWhepSession({ url, video, signal: abort.signal });
          if (destroyed) {
            session.stop();
            return;
          }
          sessionRefHandle.current = session;
          pcRef.current = session.pc;
          setStatus("Waiting for video...");
          await waitForWhepMedia(video, session.pc, 12_000, abort.signal);
          if (destroyed) {
            return;
          }
          video.muted = false;
          void video.play().catch(() => undefined);
          setStatus("Playing");
          if (sessionRef.current.ttffMs <= 0 && sessionRef.current.liveStartedAtMs > 0) {
            sessionRef.current.ttffMs = Math.max(
              1,
              Math.round(Date.now() - sessionRef.current.liveStartedAtMs),
            );
          }
          startStatsTimer();
          const iceState = await waitForWhepIceTerminal(session.pc, abort.signal);
          clearStatsTimer();
          if (destroyed) {
            return;
          }
          const playedOk =
            sessionRef.current.ttffMs > 0 || sessionRef.current.maxVideoTime > 0.25;
          if (
            isGracefulWhepDisconnect({
              playedOk,
              iceState,
              jobStatus: jobStatusRef.current,
              benchmarkLoading: loadingRef.current,
              videoTimeSec: sessionRef.current.maxVideoTime,
              encodeDurationSec: encodeDurationRef.current,
            })
          ) {
            session.stop();
            sessionRefHandle.current = null;
            pcRef.current = null;
            setError(null);
            setStatus("Playback OK");
            return;
          }
          throw new Error(`WHEP ICE ${iceState}.`);
        } catch (err) {
          clearStatsTimer();
          sessionRefHandle.current?.stop();
          sessionRefHandle.current = null;
          pcRef.current = null;
          if (destroyed || (err instanceof DOMException && err.name === "AbortError")) {
            return;
          }
          sessionRef.current.errorCount += 1;
          const playedOk =
            sessionRef.current.ttffMs > 0 || sessionRef.current.maxVideoTime > 0.25;
          const iceMatch = /WHEP ICE (failed|disconnected|closed)/i.exec(
            err instanceof Error ? err.message : "",
          );
          if (
            iceMatch &&
            isGracefulWhepDisconnect({
              playedOk,
              iceState: iceMatch[1],
              jobStatus: jobStatusRef.current,
              benchmarkLoading: loadingRef.current,
              videoTimeSec: sessionRef.current.maxVideoTime,
              encodeDurationSec: encodeDurationRef.current,
            })
          ) {
            setError(null);
            setStatus("Playback OK");
            return;
          }
          setError(
            unwrapFastApiDetail(
              err instanceof Error
                ? err.message
                : "WHEP connection failed. Is the WHEP gateway running and the stream live?",
            ),
          );
          setStatus("Retrying WHEP...");
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }
    }

    void start();

    return () => {
      destroyed = true;
      abort.abort();
      persistJobRebuffer(jobId, rebufferRef.current);
      detachHtmlMonitors?.();
      clearStatsTimer();
      video.removeEventListener("timeupdate", onTimeUpdate);
      sessionRefHandle.current?.stop();
      sessionRefHandle.current = null;
      pcRef.current = null;
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [url, playbackGate, jobId]);

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
