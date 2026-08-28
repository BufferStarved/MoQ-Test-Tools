import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
import { usePlaybackMetricsReporter } from "../playbackMetrics";
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
import { isPlausibleE2eMs, pathDelayMs } from "../glassLatency";
import { isGracefulWhepDisconnect, unwrapFastApiDetail } from "../playbackEos";
import { startWhepSession, waitForWhepIceTerminal, waitForWhepMedia, type WhepSession } from "../whepSession";
import {
  classifyWhepEndVerdict,
  whepHasRenderedMedia,
  whepPlaybackBufferSec,
} from "../webrtcPlayback";

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
  encodeElapsedSec?: number;
  runStopped?: boolean;
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
  encodeElapsedSec,
  runStopped = false,
}: WhepPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRefHandle = useRef<WhepSession | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting WHEP...");
  const lastErrorRef = useRef<string | null>(null);
  const rebufferRef = useRef(new RebufferTracker());
  const sessionRef = useRef({
    ttffMs: 0,
    liveStartedAtMs: 0,
    maxVideoTime: 0,
    errorCount: 0,
    viewerLatencyMs: 0,
    bitrateBps: 0,
    rttMs: 0,
    framesRendered: 0,
    framesDecoded: 0,
    framesDropped: 0,
    // Startup milestones (epoch ms) for the player-chain decomposition.
    sdpAnsweredAtMs: 0,
    firstMediaAtMs: 0,
    firstPaintAtMs: 0,
  });
  const startupPhasesRef = useRef<StartupPlayerPhases>({ ...EMPTY_STARTUP_PHASES });
  const lagRef = useRef({ bridgeMs: 0, encoderMs: 0 });
  lagRef.current = { bridgeMs: bridgeLagMs, encoderMs: encoderLagMs };
  const jobStatusRef = useRef(jobStatus);
  jobStatusRef.current = jobStatus;
  const loadingRef = useRef(benchmarkLoading);
  loadingRef.current = benchmarkLoading;
  const encodeDurationRef = useRef(encodeDurationSec);
  encodeDurationRef.current = encodeDurationSec;
  const encodeElapsedRef = useRef(encodeElapsedSec ?? 0);
  encodeElapsedRef.current = encodeElapsedSec ?? 0;
  const runStoppedRef = useRef(runStopped);
  runStoppedRef.current = runStopped;

  /**
   * Player-chain startup phases (see src/startup_budget.py).
   *
   * `player_request` is Resource Timing on the WHEP POST (`fetchStart →
   * requestStart`), and on WHEP that span legitimately contains more than DNS +
   * connect + TLS: the offer cannot be posted until local ICE gathering
   * finishes (up to 4s in whepSession), and gathering is genuinely part of
   * "attach → request sent" here.
   *
   * `manifest` is the SDP exchange, closed by wall clock when the answer has
   * been applied rather than by the POST's own Resource Timing entry. The
   * negotiation retries a 404/425 up to twelve times while MediaMTX comes up,
   * reusing one gathered offer; the *first* entry is only the first attempt, so
   * timing the exchange from the entry would charge every retry to first_media
   * instead. The Resource Timing entry is still the cross-check — with the
   * signaling proxy in play (an https page cannot POST to http://host:8889) the
   * entry is same-origin and visible; a direct POST to the MediaMTX host is
   * cross-origin, so `player_request` reports unmeasured unless MediaMTX sends
   * `Timing-Allow-Origin`. That is the one phase most likely to be blank on
   * this engine.
   *
   * `first_media` runs from the answer to the first `inbound-rtp` byte and
   * therefore contains ICE connectivity checks and the DTLS handshake, matching
   * PLAYER_PHASE_NOTES["whep"].
   */
  function startupPhases(): StartupPlayerPhases {
    const session = sessionRef.current;
    const post = findStartupResourceTiming(url);
    startupPhasesRef.current = latchStartupPhases(
      startupPhasesRef.current,
      startupPhasesFromMilestones({
        attachAtMs: session.liveStartedAtMs,
        requestSentAtMs: post.requestSentAtMs,
        manifestReceivedAtMs: session.sdpAnsweredAtMs,
        firstMediaAtMs: session.firstMediaAtMs,
        firstPaintAtMs: session.firstPaintAtMs,
      }),
    );
    return startupPhasesRef.current;
  }

  const getPlaybackSnapshot = useCallback((): PlaybackMetricsSnapshot => {
    const frames = readVideoFrameStats(videoRef.current);
    sessionRef.current.framesRendered = Math.max(
      sessionRef.current.framesRendered,
      frames.framesRendered,
      sessionRef.current.framesDecoded,
    );
    const video = videoRef.current;
    if (video) {
      const vt = video.currentTime;
      if (vt > sessionRef.current.maxVideoTime) {
        sessionRef.current.maxVideoTime = vt;
      }
    }
    persistJobRebuffer(jobId, rebufferRef.current);
    const { bridgeMs, encoderMs } = lagRef.current;
    const e2e = pathDelayMs({
      encodeLagMs: encoderMs,
      rttMs: sessionRef.current.rttMs,
      playerBufferMs: sessionRef.current.viewerLatencyMs + bridgeMs,
    });
    return {
      playback_stats_events: sessionRef.current.framesRendered > 0 ? 1 : 0,
      playback_stall_count: rebufferRef.current.stallCount,
      playback_frames_rendered: sessionRef.current.framesRendered,
      playback_frames_dropped: Math.max(
        frames.framesDropped,
        sessionRef.current.framesDropped,
      ),
      playback_bitrate_bps: sessionRef.current.bitrateBps,
      playback_ttff_ms: sessionRef.current.ttffMs,
      playback_hls_errors: sessionRef.current.errorCount,
      playback_hls_fatal_errors: 0,
      playback_hls_buffer_stalls: 0,
      playback_hls_frag_loads: 0,
      playback_video_time_sec: sessionRef.current.maxVideoTime,
      playback_buffer_sec: whepPlaybackBufferSec({
        jitterBufferMs: sessionRef.current.viewerLatencyMs,
        htmlBufferedAheadSec: bufferedAheadSec(videoRef.current),
      }),
      playback_rebuffer_sec: rebufferRef.current.totalSec,
      e2e_latency_ms: e2e && isPlausibleE2eMs(e2e) ? e2e : undefined,
      ...startupPhases(),
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
    const mountedVideo = videoRef.current;
    if (!mountedVideo) {
      return;
    }
    // TS carries `const` narrowing into arrow functions but not into the
    // hoisted `function` declarations below, so bind the guarded element to an
    // explicitly non-null alias rather than re-checking in every handler.
    const video: HTMLVideoElement = mountedVideo;

    if (playbackGate !== "live") {
      if (playbackGate === "ended") {
        const verdict = classifyWhepEndVerdict({
          framesRendered: sessionRef.current.framesRendered,
          videoTimeSec: sessionRef.current.maxVideoTime,
          lastError: lastErrorRef.current,
          encodeDurationSec: encodeDurationRef.current,
          encodeElapsedSec: encodeElapsedRef.current,
          runStopped: runStoppedRef.current,
        });
        if (verdict.ok) {
          setError(null);
          lastErrorRef.current = null;
          setStatus(verdict.status);
        } else {
          lastErrorRef.current = verdict.error;
          setError(verdict.error);
          setStatus(verdict.status);
        }
        return;
      }
      setStatus(
        playbackGate === "waiting" ? "Waiting for WebRTC publish..." : playbackGateLabel(playbackGate, "other"),
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
      framesRendered: 0,
      framesDecoded: 0,
      framesDropped: 0,
      sdpAnsweredAtMs: 0,
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

    const clearStatsTimer = () => {
      if (statsTimer != null) {
        window.clearInterval(statsTimer);
        statsTimer = null;
      }
    };

    /**
     * Close the `first_media` phase at the first `inbound-rtp` byte.
     *
     * Deliberately not folded into the 1s stats timer above: that is a gauge
     * cadence, and reading the milestone there would quantise both `first_media`
     * and `first_paint` to whole seconds — coarser than the phases themselves.
     *
     * The transport-state listeners are what make a fast poll cheap. RTP cannot
     * arrive before ICE has a working candidate pair and DTLS has completed, so
     * polling only starts once the peer connection reports connected, and stops
     * at the first byte. `transport.dtlsState` is read in the same pass, so the
     * poll cannot mistake a stray pre-handshake counter for media.
     */
    const FIRST_MEDIA_POLL_MS = 100;
    let firstMediaTimer: number | null = null;
    let detachTransportWatch: (() => void) | null = null;

    const stopFirstMediaWatch = () => {
      if (firstMediaTimer != null) {
        window.clearInterval(firstMediaTimer);
        firstMediaTimer = null;
      }
      detachTransportWatch?.();
      detachTransportWatch = null;
    };

    const watchFirstMedia = (pc: RTCPeerConnection) => {
      stopFirstMediaWatch();
      const poll = () => {
        if (destroyed || sessionRef.current.firstMediaAtMs > 0) {
          stopFirstMediaWatch();
          return;
        }
        void pc
          .getStats()
          .then((report) => {
            if (destroyed || sessionRef.current.firstMediaAtMs > 0) {
              return;
            }
            let dtlsConnected = false;
            let bytes = 0;
            report.forEach((stat) => {
              if (stat.type === "transport") {
                const transport = stat as RTCTransportStats;
                if (transport.dtlsState === "connected") {
                  dtlsConnected = true;
                }
              }
              if (stat.type === "inbound-rtp" && (stat as RTCInboundRtpStreamStats).kind !== "audio") {
                bytes = Math.max(bytes, (stat as RTCInboundRtpStreamStats).bytesReceived ?? 0);
              }
            });
            if (dtlsConnected && bytes > 0) {
              sessionRef.current.firstMediaAtMs = Date.now();
              stopFirstMediaWatch();
            }
          })
          .catch(() => undefined);
      };
      const onTransportState = () => {
        if (destroyed || firstMediaTimer != null) {
          return;
        }
        const ice = pc.iceConnectionState;
        if (pc.connectionState === "connected" || ice === "connected" || ice === "completed") {
          firstMediaTimer = window.setInterval(poll, FIRST_MEDIA_POLL_MS);
          poll();
        }
      };
      pc.addEventListener("connectionstatechange", onTransportState);
      pc.addEventListener("iceconnectionstatechange", onTransportState);
      detachTransportWatch = () => {
        pc.removeEventListener("connectionstatechange", onTransportState);
        pc.removeEventListener("iceconnectionstatechange", onTransportState);
      };
      // Connection may already be up by the time the answer was applied.
      onTransportState();
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
          let decoded = 0;
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
            const frames = inbound.framesDecoded ?? 0;
            if (frames >= decoded) {
              decoded = frames;
            }
            const dropped = inbound.framesDropped ?? 0;
            if (dropped > 0) {
              sessionRef.current.framesDropped = Math.max(
                sessionRef.current.framesDropped ?? 0,
                dropped,
              );
            }
          });
          if (decoded > 0) {
            sessionRef.current.framesDecoded = Math.max(
              sessionRef.current.framesDecoded,
              decoded,
            );
          }
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
          setStatus("Connecting...");
          const session = await startWhepSession({ url, video, signal: abort.signal });
          if (destroyed) {
            session.stop();
            return;
          }
          sessionRefHandle.current = session;
          pcRef.current = session.pc;
          // startWhepSession resolves once the answer SDP has been applied, so
          // this closes the WHEP exchange including any 404/425 retries while
          // MediaMTX came up. Latched: a reconnect renegotiates against a
          // warm gateway and would describe a different join.
          if (sessionRef.current.sdpAnsweredAtMs <= 0) {
            sessionRef.current.sdpAnsweredAtMs = Date.now();
          }
          watchFirstMedia(session.pc);
          setStatus("Waiting for video...");
          await waitForWhepMedia(video, session.pc, 12_000, abort.signal);
          if (destroyed) {
            return;
          }
          // Stay muted. Unmuting here rejects autoplay in headless Chrome
          // (NotAllowedError), which left WHEP connected but never painting.
          video.muted = true;
          void video.play().catch(() => undefined);
          lastErrorRef.current = null;
          setError(null);
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
          stopFirstMediaWatch();
          if (destroyed) {
            return;
          }
          const playedOk = whepHasRenderedMedia({
            framesRendered: sessionRef.current.framesRendered,
          });
          if (
            isGracefulWhepDisconnect({
              playedOk,
              iceState,
              jobStatus: jobStatusRef.current,
              benchmarkLoading: loadingRef.current,
              videoTimeSec: sessionRef.current.maxVideoTime,
              encodeDurationSec: encodeDurationRef.current,
              encodeElapsedSec: encodeElapsedRef.current,
              runStopped: runStoppedRef.current,
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
          stopFirstMediaWatch();
          sessionRefHandle.current?.stop();
          sessionRefHandle.current = null;
          pcRef.current = null;
          if (destroyed || (err instanceof DOMException && err.name === "AbortError")) {
            return;
          }
          sessionRef.current.errorCount += 1;
          const playedOk = whepHasRenderedMedia({
            framesRendered: sessionRef.current.framesRendered,
          });
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
              encodeElapsedSec: encodeElapsedRef.current,
              runStopped: runStoppedRef.current,
            })
          ) {
            setError(null);
            setStatus("Playback OK");
            return;
          }
          const detail = unwrapFastApiDetail(
            err instanceof Error
              ? err.message
              : "WHEP connection failed. Is the WHEP gateway running and the stream live?",
          );
          lastErrorRef.current = detail;
          setError(detail);
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
      stopFirstMediaWatch();
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
