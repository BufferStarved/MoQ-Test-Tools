import { useCallback, useEffect, useRef, useState } from "react";
import { WebCodecsVideoDecoder } from "@moqt/browser";
import { Player } from "@playa/player";
import { postPlaybackSample, type PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { browserLocCatalogTracks } from "../browserMoq/locCatalog";
import { createStrictMoqtTransport } from "../browserMoq/webTransport";
import { OPENMOQ_AUDIO_TRACK, OPENMOQ_VIDEO_TRACK } from "../moqOpenmoqCatalog";
import { moqCatchUpConfig } from "../encodeProfiles";
import { classifyLocFrameStall, locSubscribeOptions } from "../moqLocPlayback";
import {
  classifyCmafPlayheadStall,
  classifyMoqEndVerdict,
  cmafSubscribeOptions,
  moqHasRenderedMedia,
  moqRenderSink,
  noMediaFailMessage,
  noMediaTimeoutMs,
  playerErrorForFailedJob,
  shouldKeepSessionOnSubscribeError,
} from "../moqCmafPlayback";
import {
  markMoqCatalogReady,
  markMoqFirstFrame,
  moqPlaybackSucceeded,
  resetMoqPlaybackOutcome,
  getMoqPlaybackOutcome,
} from "../moqPlaybackOutcome";
import { bufferedAheadSec, RebufferTracker, seekNearLiveEdge } from "../playbackBuffer";
import { clockSkewMs } from "../clockSkew";
import { createPlaybackDiagReporter } from "../playbackDiag";
import { elapsedSecFromStart, usePlaybackMetricsReporter } from "../playbackMetrics";
import {
  attachHtmlPlaybackMonitors,
  attachFrameStallMonitor,
  loadJobRebuffer,
  persistJobRebuffer,
  readVideoFrameStats,
} from "../videoPlaybackMetrics";
import { computeMoqE2eMs } from "../glassLatency";
import { isGracefulMoqReset } from "../playbackEos";
import { PlayerDiagnostics } from "./PlayerDiagnostics";

interface MoqPlayerProps {
  relayUrl: string;
  namespace: string;
  fingerprintUrl?: string;
  label: string;
  playbackGate?: PlaybackGate;
  pinTlsCert?: boolean;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  /** Encode/publish error from the job record — prefer this over a catalog miss. */
  jobError?: string | null;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
  /** Glass-to-glass budget from upload config (ms). */
  targetLatencyMs?: number;
  /**
   * Whether the publish source actually carries an audio track. Advertising
   * audio in the injected catalog when the capture is video-only (no/denied
   * mic) makes the player subscribe to a track the publisher never registers
   * — the relay refuses it and the player fatally tears down the healthy
   * video subscription with it (reproduced via QA harness, 2026-07-20).
   */
  sourceHasAudio?: boolean;
  /** Capture->bridge-output lag (ms) for live webcam runs; 0 for VOD. */
  bridgeLagMs?: number;
  /** This leg's encoder lag behind realtime (ms). */
  encoderLagMs?: number;
  /** Path RTT from the latest encode/transport sample (ms). */
  netRttMs?: number;
  /** MOQT draft to offer on WebTransport (16 for openmoq/ffmpeg, 18 for browser MOQ5). */
  draftVersion?: 16 | 18;
  /** Browser source publishes LOC; ffmpeg/openmoq publishes CMAF. */
  mediaPackaging?: "cmaf" | "loc";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Was 6s — that alone pinned wall−vt E2E near ~7s after join. CMAF catalog is
// a one-shot group-0 object on moqx; subscribe must start before it is sent.
const PUBLISHER_WARMUP_MS = 250;
/** Cover publisher startup (namespace 0x10) without waiting past catalog publish. */
const MAX_CONNECT_ATTEMPTS = 12;
/** If SUBSCRIBE_OK arrived after catalog group 0, tear down and resubscribe. */
const CATALOG_RETRY_MS = 4_000;

const LIVE_EDGE_TRIM_MS = 2_000;
// Mid-play recovery: a session that dies after first frame used to be
// silently swallowed (the error handler returned on firstFrame), leaving a
// frozen video for the rest of the run while the page kept posting the same
// stale playback snapshot (observed live: job a067f876 froze at vt=0.96s at
// t≈6s and never recovered, publisher healthy the whole 60s).
const MAX_SESSION_RESTARTS = 3;
const SESSION_RESTART_DELAY_MS = 2_000;
// Playhead frozen this long while the encode is live => the session is dead
// even if playa never surfaced an error; tear down and resubscribe.
const STALL_RESTART_MS = 8_000;
// Early-join window: used to fast-resubscribe CMAF after a 1.75s freeze.
// That killed healthy live-edge holds (vt≈3s, ~0.5s buffered) and the
// reconnect reset MSE to 0 — catalog is one-shot, so 2/3 and 3/3 never
// recovered. Both CMAF and LOC now hold; a LOC resubscribe RESET_STREAMs
// the live publisher (demo 2026-08-18: 4 frames then restart 1/3–3/3).
const EARLY_JOIN_WINDOW_MS = 15_000;
const EARLY_STALL_RESTART_MS = 1_750;
// Watchdog needs sub-second ticks to catch early starvation promptly; the
// live-edge trim keeps its original 2s cadence via a tick divider below.
const WATCHDOG_TICK_MS = 500;
// Small-gap escape: CMAF fragment boundaries can leave sub-second MSE buffer
// holes that freeze the playhead with media queued right behind them. Jump
// them after ~1.5s instead of waiting for the stall watchdog (which burns a
// full session restart on what is just a buffered hole).
const GAP_JUMP_AFTER_MS = 1_500;
const GAP_JUMP_MAX_HOLE_SEC = 1.5;
// Live-edge catch-up rate cap. Proportional between 1.0 and this based on
// how far past the hold target the buffer lead has drifted; 1.25 recovers a
// 4s overshoot in ~16s, fast enough to matter within a benchmark run while
// staying just below obvious motion speed-up.
const MAX_CATCH_UP_RATE = 1.25;

export default function MoqPlayer({
  relayUrl,
  namespace,
  fingerprintUrl,
  label,
  playbackGate = "idle",
  pinTlsCert = false,
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  jobStatus,
  jobError = null,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  targetLatencyMs = 400,
  sourceHasAudio = true,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  netRttMs = 0,
  draftVersion = 16,
  mediaPackaging = "cmaf",
}: MoqPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for encode...");
  const [isPlaying, setIsPlaying] = useState(false);
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const pinnedDiagRef = useRef<string[]>([]);
  const rollingDiagRef = useRef<string[]>([]);
  const lastTimelineDiagRef = useRef(0);
  const lastErrorRef = useRef<string | null>(null);
  const sessionRef = useRef({
    catalogReady: false,
    firstFrame: false,
    statsEvents: 0,
    stallCount: 0,
    framesRendered: 0,
    framesDropped: 0,
    bitrateBps: 0,
    ttffMs: 0,
    videoTimeSec: 0,
    playerLatencyMs: 0,
    sessionRestarts: 0,
    // Latest MoQ media-timeline position (ms) from playa's timeupdate — the
    // LEG ENCODER's output timeline (fMP4 tfdt starts ~0 at encode start),
    // unlike video.currentTime which MSE re-zeroes at join. This is what
    // makes a capture-anchored latency possible: wall-since-encode minus
    // this position minus nothing else = encoder->glass.
    moqTimelineMs: 0,
    firstFrameAtMs: 0,
    firstFrameVideoSec: 0,
  });
  const rebufferRef = useRef(new RebufferTracker());
  const lastGoodE2eRef = useRef<number | undefined>(undefined);
  const userPausedRef = useRef(false);
  const lagRef = useRef({ bridgeMs: 0, encoderMs: 0, epoch: 0, rttMs: 0 });
  lagRef.current = {
    bridgeMs: bridgeLagMs,
    encoderMs: encoderLagMs,
    epoch: encodeStartedAtEpoch ?? 0,
    rttMs: netRttMs,
  };
  const jobStatusRef = useRef(jobStatus);
  jobStatusRef.current = jobStatus;
  const jobErrorRef = useRef(jobError);
  jobErrorRef.current = jobError;
  useEffect(() => {
    const jobFail = playerErrorForFailedJob({ jobStatus, jobError });
    if (!jobFail) {
      return;
    }
    lastErrorRef.current = jobFail;
    setError(jobFail);
    setStatus("Failed");
  }, [jobStatus, jobError]);
  const loadingRef = useRef(benchmarkLoading);
  loadingRef.current = benchmarkLoading;
  const encodeDurationRef = useRef(encodeDurationSec);
  encodeDurationRef.current = encodeDurationSec;
  // Survives across effect re-mounts (unlike pinnedDiagRef, which start()
  // clears). Lets us tell from the UI alone whether the "live" effect fired
  // more than once for this component instance — e.g. because `namespace`
  // arrived late and changed identity after the gate flipped to "live",
  // which would create two Player/MediaSource instances against the same
  // <video> element and could explain spurious "SourceBuffer removed" errors.
  const mountCountRef = useRef(0);
  const lastJobIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!jobId || jobId === lastJobIdRef.current) {
      return;
    }
    lastJobIdRef.current = jobId;
    // Never clobber a successful outcome on remount (Strict Mode / prop churn).
    if (!getMoqPlaybackOutcome(jobId)) {
      resetMoqPlaybackOutcome(jobId);
    }
  }, [jobId]);

  /**
   * Glass delay in ms.
   *
   * LOC: playa `latencyMs` from LOC CaptureTimestamp (Unix-epoch µs stamped
   * at camera capture). wall−videoTime is forbidden here — when the canvas
   * freezes, videoTime stops and e2e used to climb 1:1 with wall clock.
   *
   * CMAF: encoder-timeline playhead (join offset + MSE currentTime) vs
   * encode epoch. Hold the last good sample if the playhead is frozen.
   */
  function captureAnchoredE2eMs(): number | undefined {
    const session = sessionRef.current;
    if (!session.firstFrame) {
      // pathDelay / wall−0 playhead invented ~10s e2e on a black CMAF player
      // (comparison CSV 2026-08-18: frames=0, ttff=0, e2e avg 10.7s).
      return undefined;
    }
    const { bridgeMs, epoch, encoderMs, rttMs } = lagRef.current;
    const video = videoRef.current;
    const videoTimeSec = Math.max(session.videoTimeSec, video?.currentTime ?? 0);
    const computed = computeMoqE2eMs({
      playerLatencyMs: session.playerLatencyMs,
      bridgeMs,
      encoderLagMs: encoderMs,
      rttMs,
      bufferMs: bufferedAheadSec(video) * 1000,
      mediaPackaging,
      joinOffsetSec: playerRef.current?.joinMediaOffsetSec ?? null,
      videoCurrentTimeSec: videoTimeSec,
      moqTimelineMs: session.moqTimelineMs,
      epochSec: epoch,
      clockSkewMs: clockSkewMs(),
      ttffMs: session.ttffMs,
      firstFrameAtMs: session.firstFrameAtMs,
      firstFrameVideoSec: session.firstFrameVideoSec,
    });
    if (computed != null) {
      lastGoodE2eRef.current = computed;
      return computed;
    }
    return lastGoodE2eRef.current;
  }

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => {
      const session = sessionRef.current;
      const htmlFrames = readVideoFrameStats(videoRef.current);
      // LOC paints a <canvas> — the hidden <video> never advances, so HTML
      // decoded-frame counters stay near zero and made playback look like 1–2 fps.
      const loc = mediaPackaging === "loc";
      const framesRendered = loc
        ? session.framesRendered || htmlFrames.framesRendered
        : htmlFrames.framesRendered || session.framesRendered;
      const framesDropped = loc
        ? session.framesDropped || htmlFrames.framesDropped
        : htmlFrames.framesDropped || session.framesDropped;
      if (framesRendered > 0) {
        session.statsEvents = Math.max(session.statsEvents, 1);
      }
      persistJobRebuffer(jobId, rebufferRef.current);
      return {
        playback_stats_events: session.statsEvents,
        // HTML waiting / frozen-playhead truth — not playa stall alone.
        playback_stall_count: rebufferRef.current.stallCount,
        playback_frames_rendered: framesRendered,
        playback_frames_dropped: framesDropped,
        playback_bitrate_bps: session.bitrateBps,
        playback_ttff_ms: session.ttffMs,
        playback_hls_errors: 0,
        playback_hls_fatal_errors: 0,
        playback_hls_buffer_stalls: 0,
        playback_hls_frag_loads: 0,
        playback_video_time_sec: Math.max(
          session.videoTimeSec,
          videoRef.current?.currentTime ?? 0,
        ),
        playback_buffer_sec: bufferedAheadSec(videoRef.current),
        playback_rebuffer_sec: rebufferRef.current.totalSec,
        playback_error_count: lastErrorRef.current ? 1 : 0,
        e2e_latency_ms: captureAnchoredE2eMs(),
      };
    },
    [jobId, mediaPackaging],
  );

  usePlaybackMetricsReporter({
    jobId,
    engine: "moq",
    enabled: playbackGate === "live",
    startedAtEpoch: encodeStartedAtEpoch,
    getSnapshot: getPlaybackSnapshot,
    onSample: onPlaybackSample,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) {
      return;
    }
    // CMAF MSE is the <video> element. JSX starts it `hidden`; leaving it
    // display:none until catalog_received lets Chrome suspend the pipeline.
    if (mediaPackaging === "cmaf") {
      canvas.hidden = true;
      video.hidden = false;
    } else {
      canvas.hidden = false;
      video.hidden = true;
    }

    if (playbackGate !== "live") {
      if (playbackGate === "ended") {
        const outcome = getMoqPlaybackOutcome(jobId);
        const snapshotNow = getPlaybackSnapshot();
        const verdict = classifyMoqEndVerdict({
          firstFrame:
            moqPlaybackSucceeded(jobId) ||
            sessionRef.current.firstFrame ||
            moqHasRenderedMedia({
              framesRendered: snapshotNow.playback_frames_rendered,
              videoTimeSec: sessionRef.current.videoTimeSec,
            }),
          framesRendered: snapshotNow.playback_frames_rendered,
          videoTimeSec: Math.max(
            sessionRef.current.videoTimeSec,
            outcome?.videoTimeSec ?? 0,
          ),
          catalogReady: Boolean(outcome?.catalogReady || sessionRef.current.catalogReady),
          encodeDurationSec: encodeDurationRef.current,
          sessionRestarts: sessionRef.current.sessionRestarts,
          lastError: lastErrorRef.current,
          namespace,
          jobStatus: jobStatusRef.current,
          jobError: jobErrorRef.current,
        });
        if (verdict.ok) {
          setError(null);
          lastErrorRef.current = null;
          setStatus(verdict.status);
        } else {
          lastErrorRef.current = verdict.error;
          setError(verdict.error);
          setStatus(verdict.status);
          const snapshot = {
            ...snapshotNow,
            playback_error_count: 1,
            elapsed_sec: elapsedSecFromStart(encodeStartedAtEpoch),
            engine: "moq" as const,
            at_epoch: Date.now() / 1000,
          };
          onPlaybackSample?.(snapshot);
          if (jobId) {
            void postPlaybackSample(jobId, snapshot).catch(() => undefined);
          }
        }
      } else {
        setStatus(
          playbackGate === "waiting" ? "Waiting for MoQ publish..." : "Waiting for encode...",
        );
      }
      setIsReady(false);
      setIsPlaying(false);
      return;
    }

    mountCountRef.current += 1;
    const mountNumber = mountCountRef.current;
    // eslint-disable-next-line no-console
    console.log(
      `[MoqPlayer] live-effect mount #${mountNumber} gate=${playbackGate} relay=${relayUrl} namespace=${namespace} ` +
        `fingerprintUrl=${fingerprintUrl} pinTlsCert=${pinTlsCert} draft=${draftVersion} encodeDurationSec=${encodeDurationSec} jobStatus=${jobStatus} benchmarkLoading=${benchmarkLoading}`,
    );

    let destroyed = false;
    let connectTimeout: ReturnType<typeof window.setTimeout> | undefined;
    let liveEdgeTimer: ReturnType<typeof window.setInterval> | undefined;
    let playKickTimer: ReturnType<typeof window.setInterval> | undefined;
    let decodeKickTimer: ReturnType<typeof window.setTimeout> | undefined;
    const priorOutcome = getMoqPlaybackOutcome(jobId);
    sessionRef.current = {
      catalogReady: Boolean(priorOutcome?.catalogReady),
      firstFrame: Boolean(priorOutcome?.firstFrame),
      statsEvents: 0,
      stallCount: 0,
      framesRendered: 0,
      framesDropped: 0,
      bitrateBps: 0,
      ttffMs: priorOutcome?.ttffMs ?? 0,
      videoTimeSec: priorOutcome?.videoTimeSec ?? 0,
      playerLatencyMs: 0,
      moqTimelineMs: 0,
      firstFrameAtMs: 0,
      firstFrameVideoSec: 0,
      sessionRestarts: 0,
    };
    // Remounts used to wipe rebuffer to 0 mid-run — restore per-job accum.
    rebufferRef.current.reset();
    loadJobRebuffer(jobId, rebufferRef.current);
    // LOC has no MSE <video> clock. The frozen-playhead monitor on a hidden
    // element counted a stall every ~800ms and the watchdog resubscribed —
    // that read as extreme chop, not as a bandwidth problem.
    lastGoodE2eRef.current = undefined;
    const detachHtmlMonitors =
      mediaPackaging === "loc"
        ? attachFrameStallMonitor({
            rebuffer: rebufferRef.current,
            getFrames: () => sessionRef.current.framesRendered,
            hasPlayedOnce: () =>
              sessionRef.current.firstFrame || sessionRef.current.ttffMs > 0,
          })
        : attachHtmlPlaybackMonitors(video, {
            rebuffer: rebufferRef.current,
            hasPlayedOnce: () =>
              sessionRef.current.firstFrame || sessionRef.current.ttffMs > 0,
            onStallBegin: () => {
              sessionRef.current.stallCount = rebufferRef.current.stallCount;
              persistJobRebuffer(jobId, rebufferRef.current);
            },
          });

    const diagReporter = createPlaybackDiagReporter(jobId, "moq");

    function pushDiag(line: string, pin = false) {
      if (destroyed) {
        return;
      }
      if (pin) {
        if (!pinnedDiagRef.current.includes(line)) {
          pinnedDiagRef.current = [...pinnedDiagRef.current, line];
        }
      } else {
        rollingDiagRef.current = [...rollingDiagRef.current.slice(-10), line];
      }
      setDiagLines([...pinnedDiagRef.current, ...rollingDiagRef.current].slice(-20));
      diagReporter.push(line);
    }

    function fail(message: string) {
      const jobFail = playerErrorForFailedJob({
        jobStatus: jobStatusRef.current,
        jobError: jobErrorRef.current,
      });
      const shown = jobFail || message;
      lastErrorRef.current = shown;
      setError(shown);
      setStatus("Failed");
      setIsReady(false);
      setIsPlaying(false);
      diagReporter.push(`FAIL ${shown}`);
    }

    function armFrameTimeout(label: string) {
      if (connectTimeout) {
        window.clearTimeout(connectTimeout);
      }
      connectTimeout = window.setTimeout(() => {
        if (destroyed || sessionRef.current.firstFrame) {
          return;
        }
        fail(`MoQ catalog loaded but no frames rendered within 35s (${label}).`);
      }, 35000);
    }

    async function fetchCertHash(): Promise<ArrayBuffer | undefined> {
      if (!pinTlsCert || !fingerprintUrl) {
        return undefined;
      }
      const response = await fetch(fingerprintUrl);
      if (!response.ok) {
        throw new Error(
          `MoQ TLS fingerprint unavailable (${response.status}). Restart the API after relay cert changes.`,
        );
      }
      const hex = (await response.text()).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        throw new Error("MoQ TLS fingerprint from API is invalid.");
      }
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    function updateMediaVisibility(player: Player) {
      // Packaging decides the sink — not playa.activeMediaType. That getter
      // is null until catalog_received, and updateMediaVisibility used to
      // hide <video> on "unknown" (display:none suspends Chrome MSE).
      const sink = moqRenderSink(mediaPackaging);
      const playaType = player.activeMediaType;
      pushDiag(`media_sink=${sink} playa=${playaType ?? "unknown"}`, true);
      if (sink === "video") {
        canvas.hidden = true;
        video.hidden = false;
      } else {
        canvas.hidden = false;
        video.hidden = true;
      }
    }

    // Live-edge catch-up rate the watchdog wants applied (1.0 = realtime).
    // Owned here so onTimeUpdate's rate-defense snaps to the *intended* rate
    // instead of fighting the catch-up back to 1.0 every timeupdate.
    let catchUpRate = 1;

    function locHasMedia(): boolean {
      return sessionRef.current.framesRendered > 0;
    }

    function noteFirstFrame(source: string) {
      if (destroyed) {
        return;
      }
      const locReady = mediaPackaging === "loc" && locHasMedia();
      if (!locReady && video.currentTime <= 0.25) {
        return;
      }
      const wasFirst = !sessionRef.current.firstFrame;
      const mediaTimeSec =
        mediaPackaging === "loc"
          ? Math.max(sessionRef.current.videoTimeSec, sessionRef.current.framesRendered / 30)
          : video.currentTime;
      sessionRef.current.firstFrame = true;
      sessionRef.current.videoTimeSec = Math.max(sessionRef.current.videoTimeSec, mediaTimeSec);
      if (sessionRef.current.firstFrameAtMs <= 0) {
        sessionRef.current.firstFrameAtMs = Date.now();
        sessionRef.current.firstFrameVideoSec = mediaTimeSec;
      }
      markMoqFirstFrame(jobId, {
        ttffMs: sessionRef.current.ttffMs,
        videoTimeSec: sessionRef.current.videoTimeSec,
      });
      if (!wasFirst) {
        return;
      }
      lastErrorRef.current = null;
      if (connectTimeout) {
        window.clearTimeout(connectTimeout);
      }
      pushDiag(
        mediaPackaging === "loc"
          ? `first_frame=ok via=${source} loc_time=${mediaTimeSec.toFixed(2)} sink=canvas`
          : `first_frame=ok via=${source} video_time=${video.currentTime.toFixed(2)} size=${video.videoWidth}x${video.videoHeight}`,
      );
      setError(null);
      setIsPlaying(true);
      setStatus("Playing");
      if (mediaPackaging !== "loc" && Math.abs(video.playbackRate - catchUpRate) > 0.01) {
        pushDiag(`playback_rate_reset from=${video.playbackRate}`);
        video.playbackRate = catchUpRate;
      }
    }

    function onTimeUpdate() {
      if (destroyed) {
        return;
      }
      if (Math.abs(video.playbackRate - catchUpRate) > 0.01) {
        video.playbackRate = catchUpRate;
      }
      if (sessionRef.current.firstFrame) {
        return;
      }
      noteFirstFrame("video.timeupdate");
    }

    async function start() {
      const catalogWaitMs = Math.max((encodeDurationSec + 25) * 1000, 50_000);
      const catalogWaitSec = Math.round(catalogWaitMs / 1000);
      setError(null);
      lastErrorRef.current = null;
      setDiagLines([]);
      pinnedDiagRef.current = [];
      rollingDiagRef.current = [];
      lastTimelineDiagRef.current = 0;
      userPausedRef.current = false;
      setStatus("Waiting for publisher...");
      pushDiag(`relay=${relayUrl} namespace=${namespace}`, true);
      pushDiag(
        mediaPackaging === "loc"
          ? `catalog_mode=injected loc video${sourceHasAudio ? "+audio" : ""} draft=${draftVersion}`
          : `catalog_mode=relay catalog then ${OPENMOQ_VIDEO_TRACK}+${OPENMOQ_AUDIO_TRACK} (publisher initData) draft=${draftVersion}`,
        true,
      );
      pushDiag(`publisher_forward=1 warmup=${PUBLISHER_WARMUP_MS / 1000}s`, true);
      setIsReady(false);

      let retrying = false;
      let sessionRestarts = 0;
      let currentAttempt = 1;
      let sharedCertHash: ArrayBuffer | undefined;

      /**
       * Tear down a dead mid-play session and resubscribe. The publisher and
       * relay routinely outlive a browser-side session death (WebTransport
       * drop, MSE teardown), so reconnecting resumes playback at the next
       * group instead of freezing the player for the rest of the run.
       */
      function scheduleSessionRestart(reason: string, delayMs = SESSION_RESTART_DELAY_MS) {
        if (destroyed || retrying) {
          return;
        }
        retrying = true;
        sessionRestarts += 1;
        sessionRef.current.sessionRestarts = sessionRestarts;
        // CMAF catalog is one-shot. After destroy(), MSE currentTime is 0 —
        // drop firstFrame so the watchdog waits for the new session instead
        // of counting vt=0 as playhead_frozen_0.00s_early_join.
        if (mediaPackaging === "cmaf") {
          sessionRef.current.firstFrame = false;
        }
        // Fresh subscription starts at the live edge — no leftover catch-up.
        catchUpRate = 1;
        video.playbackRate = 1;
        pushDiag(`session_restart=${sessionRestarts}/${MAX_SESSION_RESTARTS} reason=${reason}`, true);
        if (connectTimeout) {
          window.clearTimeout(connectTimeout);
        }
        playerRef.current?.destroy();
        playerRef.current = null;
        setIsReady(false);
        setIsPlaying(false);
        setStatus("Reconnecting...");
        void (async () => {
          await sleep(delayMs);
          retrying = false;
          if (destroyed) {
            return;
          }
          try {
            await connectAndLoad(currentAttempt + 1, sharedCertHash);
          } catch (err) {
            playerRef.current?.destroy();
            playerRef.current = null;
            setIsReady(false);
            if (!destroyed) {
              fail(
                err instanceof Error
                  ? err.message
                  : "MoQ reconnect failed after a mid-play session error.",
              );
            }
          }
        })();
      }

      async function connectAndLoad(
        attempt: number,
        certHash: ArrayBuffer | undefined,
      ): Promise<void> {
        if (destroyed) {
          return;
        }
        currentAttempt = attempt;

        if (!Player.isSupported()) {
          const support = Player.checkSupport();
          throw new Error(
            support.reason || "MoQ playback is not supported in this browser (needs WebTransport).",
          );
        }

        let statsZeroLogged = false;
        let keptPublisherNotReady = false;
        setStatus(attempt === 1 ? "Connecting..." : "Retrying subscribe...");
        if (attempt > 1) {
          pushDiag(`subscribe_retry=attempt${attempt}`, true);
        }

        const catchUp = moqCatchUpConfig(targetLatencyMs || 400, mediaPackaging);
        pushDiag(
          `catch_up target=${catchUp.targetLatencyMs}ms maxRate=${catchUp.maxCatchUpRate} ` +
            `threshold=${catchUp.catchUpThresholdMs}ms warmup=${PUBLISHER_WARMUP_MS}ms`,
          true,
        );
        const player = new Player(null, {
          url: relayUrl,
          namespace,
          draftVersion,
          certHash,
          canvas,
          ...(mediaPackaging === "loc" ? {} : { video }),
          muted: true,
          autoplay: false,
          targetLatencyMs: catchUp.targetLatencyMs,
          // Catch-up + subscribe filter must go through moqtPlayerConfig —
          // @playa/player only forwards a subset of top-level options.
          moqtPlayerConfig: {
            // LOC: inject names (browser publisher has no MSF catalog track).
            // CMAF: do NOT inject a canned catalog. NextGroupStart joins
            // mid-stream, so MSE must initialize from the publisher's
            // `--publish-catalog` initData for *this* encode. A baked
            // 720p blob from another ffmpeg produced catalog-ready +
            // zero frames on every relay.
            createTransport: createStrictMoqtTransport({
              ...(certHash ? { certHash } : {}),
              draftVersion,
            }),
            ...(mediaPackaging === "loc"
              ? {
                  catalog: browserLocCatalogTracks({ includeAudio: sourceHasAudio }),
                  // Hardware VideoDecoder can fail silently mid-stream (~9s on
                  // both relays, recv still ~2.3 Mbps). Software is slower but
                  // keeps the canvas painting for a 300s webcam run.
                  createVideoDecoder: () => new WebCodecsVideoDecoder({ preferSoftwareDecoder: true }),
                }
              : {}),
            // LOC carries CaptureTimestamps; CMAF from openmoq does not.
            maxCatchUpRate: catchUp.maxCatchUpRate,
            catchUpThresholdMs: catchUp.catchUpThresholdMs,
            catchUpRecoveryMs: catchUp.catchUpRecoveryMs,
            // Default lateFrameThresholdMs is 100ms. Live MoQ e2e is hundreds
            // of ms, so Playa skipped every frame after the join cushion
            // (observed: ~36 rendered frames then a freeze while 2.2 Mbps
            // still arrived). Show a late frame rather than a black canvas.
            // LOC: LargestObject at the live edge — do not FETCH-warm-start
            // the current GOP. moqx honored that fetch for one group and
            // never attached later groups (same stall as NextGroupStart).
            ...(mediaPackaging === "loc" ? locSubscribeOptions() : cmafSubscribeOptions()),
          },
        });
        playerRef.current = player;

        const retrySubscribe = (reason: string, delayMs: number): boolean => {
          if (destroyed || retrying || attempt >= MAX_CONNECT_ATTEMPTS) {
            return false;
          }
          retrying = true;
          void (async () => {
            pushDiag(`${reason} attempt=${attempt} delay_ms=${delayMs}`, true);
            if (connectTimeout) {
              window.clearTimeout(connectTimeout);
            }
            player.destroy();
            if (playerRef.current === player) {
              playerRef.current = null;
            }
            sessionRef.current = {
              catalogReady: false,
              firstFrame: false,
              statsEvents: 0,
              stallCount: 0,
              framesRendered: 0,
              framesDropped: 0,
              bitrateBps: 0,
              ttffMs: 0,
              videoTimeSec: 0,
              playerLatencyMs: 0,
              moqTimelineMs: 0,
              firstFrameAtMs: sessionRef.current.firstFrameAtMs,
              firstFrameVideoSec: sessionRef.current.firstFrameVideoSec,
              sessionRestarts: sessionRef.current.sessionRestarts,
            };
            setIsReady(false);
            await sleep(delayMs);
            retrying = false;
            if (destroyed) {
              return;
            }
            try {
              await connectAndLoad(attempt + 1, certHash);
            } catch (err) {
              playerRef.current?.destroy();
              playerRef.current = null;
              setIsReady(false);
              if (!destroyed) {
                const message =
                  err instanceof Error
                    ? err.message
                    : "MoQ connection failed after subscribe retry.";
                fail(message);
              }
            }
          })();
          return true;
        };

        player.on("statechange", ({ state }) => {
          if (destroyed) {
            return;
          }
          pushDiag(`state=${state}`, state === "loading" || state === "error");
          if (state === "loading") {
            setIsPlaying(false);
            setStatus(attempt === 1 ? "Connecting..." : "Retrying subscribe...");
          } else if (state === "playing") {
            if (sessionRef.current.firstFrame) {
              setIsPlaying(true);
              setStatus("Playing");
            }
          } else if (state === "paused") {
            setIsPlaying(false);
            setStatus("Paused");
          } else if (state === "error") {
            setIsPlaying(false);
            setStatus("Failed");
          }
        });

        player.on("ready", (event) => {
          if (destroyed) {
            return;
          }
          sessionRef.current.catalogReady = true;
          markMoqCatalogReady(jobId);
          const levelNames = event.levels.map((level) => level.trackName ?? String(level.index)).join(",");
          pushDiag(
            `ready levels=${event.levels.length} tracks=${levelNames || "?"} audio=${event.audioTracks.length}`,
            true,
          );
          updateMediaVisibility(player);
          setIsReady(true);
          setStatus("Ready");
          armFrameTimeout("post-ready");
        });

        player.on("playing", () => {
          if (destroyed) {
            return;
          }
          if (mediaPackaging === "loc" || video.videoWidth > 0) {
            noteFirstFrame("player.playing");
          }
        });

        player.on("stall", ({ durationMs }) => {
          // Diagnostics only — glass rebuffer/stall come from HTML monitors
          // so MoQ matches HLS/MPEG-TS definitions (playa stalls undercount).
          pushDiag(`playa_stall_ms=${durationMs}`);
        });

        player.on("timeupdate", ({ currentTime }) => {
          // With an active <video> sink, playa emits video.currentTime*1000
          // (MSE join-relative). Keep for diagnostics; e2e uses buffer lead.
          if (destroyed) {
            return;
          }
          if (currentTime > 0) {
            sessionRef.current.moqTimelineMs = currentTime;
            // Don't advance LOC glass time from capture-clock ticks alone —
            // dropped-late frames still emit timeupdate and made e2e/stall
            // look healthy while the canvas was frozen.
          }
          if (mediaPackaging === "loc") {
            if (sessionRef.current.framesRendered > 0) {
              noteFirstFrame("player.timeupdate");
            }
          } else if (video.currentTime > 0.25 && video.videoWidth > 0) {
            noteFirstFrame("player.timeupdate");
          } else if (currentTime > 0 && !sessionRef.current.catalogReady) {
            const bucket = Math.floor(currentTime / 5000);
            if (bucket !== lastTimelineDiagRef.current) {
              lastTimelineDiagRef.current = bucket;
              pushDiag(
                `moq_timeline=${currentTime.toFixed(0)} video_time=${video.currentTime.toFixed(2)} (catalog pending)`,
              );
            }
          }
        });

        player.on("stats", (stats) => {
          sessionRef.current.framesRendered = stats.framesRendered;
          sessionRef.current.framesDropped = stats.framesDropped;
          sessionRef.current.bitrateBps = stats.bitrate;
          sessionRef.current.stallCount = Math.max(sessionRef.current.stallCount, stats.stallCount);
          sessionRef.current.ttffMs = stats.timeToFirstFrameMs ?? sessionRef.current.ttffMs;
          if (mediaPackaging === "loc") {
            if (stats.framesRendered > 0) {
              sessionRef.current.videoTimeSec = Math.max(
                sessionRef.current.videoTimeSec,
                stats.framesRendered / 30,
              );
            }
          } else {
            sessionRef.current.videoTimeSec = Math.max(
              sessionRef.current.videoTimeSec,
              video.currentTime,
            );
          }
          if (typeof stats.latencyMs === "number" && stats.latencyMs > 0) {
            sessionRef.current.playerLatencyMs = stats.latencyMs;
          }
          if (stats.framesRendered > 0) {
            sessionRef.current.statsEvents += 1;
            if (mediaPackaging === "loc" || video.currentTime > 0.25) {
              noteFirstFrame("player.stats");
            } else if (!sessionRef.current.firstFrame) {
              // MSE can report rendered frames slightly before currentTime moves.
              sessionRef.current.firstFrame = true;
              if (sessionRef.current.firstFrameAtMs <= 0) {
                sessionRef.current.firstFrameAtMs = Date.now();
                sessionRef.current.firstFrameVideoSec = sessionRef.current.videoTimeSec;
              }
              markMoqFirstFrame(jobId, {
                ttffMs: sessionRef.current.ttffMs,
                videoTimeSec: sessionRef.current.videoTimeSec,
              });
              lastErrorRef.current = null;
              if (connectTimeout) {
                window.clearTimeout(connectTimeout);
              }
              setError(null);
              setIsPlaying(true);
              setStatus("Playing");
            }
            pushDiag(
              `stats bitrate=${stats.bitrate} latency=${stats.latencyMs} ttf=${stats.timeToFirstFrameMs ?? 0} rendered=${stats.framesRendered}`,
            );
          } else if (stats.bitrate > 0 && !statsZeroLogged) {
            statsZeroLogged = true;
            pushDiag(`stats bitrate=${stats.bitrate} latency=${stats.latencyMs} rendered=0`);
          }
        });

        player.on("error", ({ severity, code, message: playerError }) => {
          if (destroyed) {
            return;
          }
          const detail = `[${severity}/${code}] ${playerError || "MoQ playback event."}`;
          pushDiag(detail);
          if (severity === "recoverable") {
            return;
          }
          if (sessionRef.current.firstFrame) {
            if (
              isGracefulMoqReset({
                playedOk: true,
                code,
                message: playerError || "",
                jobStatus: jobStatusRef.current,
                benchmarkLoading: loadingRef.current,
                videoTimeSec: sessionRef.current.videoTimeSec,
                encodeDurationSec: encodeDurationRef.current,
              })
            ) {
              player.destroy();
              if (playerRef.current === player) {
                playerRef.current = null;
              }
              lastErrorRef.current = null;
              setError(null);
              setIsPlaying(false);
              setStatus("Playback OK");
              pushDiag("graceful_eos RESET_STREAM after successful playback");
              return;
            }
            // Fatal after frames rendered. Returning here (the old behavior)
            // swallowed the error and left a dead session frozen on screen —
            // reconnect while the encode is still live, and only surface a
            // failure once the restart budget is spent.
            if (sessionRestarts < MAX_SESSION_RESTARTS) {
              if (playerRef.current !== player) {
                player.destroy();
              }
              scheduleSessionRestart(`fatal_${code}`);
            } else {
              player.destroy();
              if (playerRef.current === player) {
                playerRef.current = null;
              }
              fail(detail);
            }
            return;
          }
          if (
            severity === "fatal" &&
            shouldKeepSessionOnSubscribeError({
              firstFrame: sessionRef.current.firstFrame,
              code,
            })
          ) {
            // 0x10 / track-not-exist: do NOT destroy. Tearing down here is how
            // the one-shot CMAF catalog is published to nobody (CSV 2026-08-18:
            // moqx_subscribe_error=1, subscribe_success=0, frames=0, no UI error).
            keptPublisherNotReady = true;
            pushDiag("subscribe_0x10_keepalive (waiting for namespace/catalog)", true);
            setStatus("Waiting for publisher namespace...");
            return;
          }
          // Every other path that reaches fail() first destroys the player
          // (the retry branch above, the outer catch, the connect-timeout).
          // This was the one gap: on a fatal error with no more retries left
          // (or any other fatal), the underlying MoQ session was never torn
          // down — @playa/player kept it alive and resubscribing internally
          // on its own, well past our app-level retry cap. Confirmed live in
          // the relay's logs: one session repeating SUBSCRIBE/timeout every
          // ~2s indefinitely after we'd already given up and shown "Failed".
          player.destroy();
          if (playerRef.current === player) {
            playerRef.current = null;
          }
          fail(detail);
        });

        await player.load();
        if (destroyed) {
          return;
        }
        connectTimeout = window.setTimeout(() => {
          if (destroyed || sessionRef.current.catalogReady || sessionRef.current.firstFrame) {
            return;
          }
          // A 0x10 keepalive is still subscribed — destroying here republishes
          // the catalog-miss window. Wait for the no-media watchdog instead.
          if (keptPublisherNotReady) {
            pushDiag("catalog_timeout_skipped keepalive_0x10", true);
            return;
          }
          if (retrySubscribe("catalog_timeout_retry", 200)) {
            return;
          }
          fail(
            noMediaFailMessage({
              catalogReady: false,
              namespace,
              jobStatus: jobStatusRef.current,
              jobError: jobErrorRef.current,
            }),
          );
        }, attempt < MAX_CONNECT_ATTEMPTS ? CATALOG_RETRY_MS : catalogWaitMs);
        updateMediaVisibility(player);
        // Do not autoplay from the constructor: play() before the video
        // pipeline exists starts the 16ms tick as a no-op, then later
        // play() is ignored because the interval is already running.
        // Pause before first frame sends REQUEST_UPDATE forward:0 and
        // freezes the live subscribe at the relay.
        const startDecode = (reason: string) => {
          if (destroyed || sessionRef.current.firstFrame) {
            return;
          }
          pushDiag(`play=${reason}`, true);
          try {
            player.play();
          } catch {
            // ignore
          }
          if (video) {
            void video.play().catch(() => undefined);
          }
        };
        startDecode("post-load");
        if (mediaPackaging === "loc") {
          decodeKickTimer = window.setTimeout(() => {
            if (destroyed || sessionRef.current.firstFrame || playerRef.current !== player) {
              return;
            }
            // Play again only — pause+play used to send REQUEST_UPDATE forward:0
            // and freeze the live objects at the relay.
            pushDiag("decode_kick=play", true);
            try {
              player.play();
            } catch {
              // ignore
            }
          }, 700);
        }
        const kickPlay = () => {
          if (destroyed || sessionRef.current.firstFrame) {
            if (playKickTimer) {
              window.clearInterval(playKickTimer);
              playKickTimer = undefined;
            }
            return;
          }
          startDecode("kick");
        };
        if (playKickTimer) {
          window.clearInterval(playKickTimer);
        }
        playKickTimer = window.setInterval(kickPlay, 800);
      }

      try {
        await sleep(PUBLISHER_WARMUP_MS);
        if (destroyed) {
          return;
        }

        const certHash = await fetchCertHash();
        if (destroyed) {
          return;
        }
        sharedCertHash = certHash;
        pushDiag(certHash ? "tls_pin=ok" : "tls_pin=skipped", true);

        await connectAndLoad(1, certHash);
        if (destroyed) {
          return;
        }
        video.addEventListener("timeupdate", onTimeUpdate);
        // Live-edge policy (smoothness first):
        //  1. GENTLE RATE CATCH-UP is the primary mechanism — when the buffer
        //     lead creeps past the hold target, play slightly fast (1.08x /
        //     1.12x, imperceptible) until back at the hold. The old
        //     seek-only trim let a 4s target balloon to ~11s of buffer and
        //     then jumped 6-7s at once (webcam run 2026-08-08), which read
        //     as freezes + skips.
        //  2. HARD SEEK stays only as a gross-drift backstop (relay burst
        //     after a long stall) on the original 2s cadence.
        const holdBehindSec = Math.max(0.15, (targetLatencyMs || 400) / 1000);
        const seekThresholdSec = Math.max(holdBehindSec * 2, holdBehindSec + 1);
        const rateOnSec = holdBehindSec + 0.75; // start chasing above this lead
        const rateOffSec = holdBehindSec + 0.25; // stop chasing below this lead
        // Frozen-playhead watchdog state (see STALL_RESTART_MS).
        let watchdogVt = -1;
        let watchdogAtMs = Date.now();
        let watchdogGaveUp = false;
        let lastLocFrames = 0;
        // Wall time the watchdog first saw rendered media this run. Anchors the
        // EARLY_JOIN_WINDOW_MS fast-restart window (survives session restarts:
        // the window is measured from the run's first media, not per session).
        let firstMediaAtMs = 0;
        let watchdogTick = 0;
        const liveStartedAtMs = Date.now();
        const mediaDeadlineMs = noMediaTimeoutMs(encodeDurationRef.current);
        const liveEdgeTickDivider = Math.max(1, Math.round(LIVE_EDGE_TRIM_MS / WATCHDOG_TICK_MS));
        liveEdgeTimer = window.setInterval(() => {
          if (destroyed) {
            return;
          }
          if (!sessionRef.current.firstFrame) {
            const encodeOver =
              jobStatusRef.current === "completed" || jobStatusRef.current === "failed";
            if (
              !lastErrorRef.current &&
              (encodeOver || Date.now() - liveStartedAtMs >= mediaDeadlineMs)
            ) {
              fail(
                noMediaFailMessage({
                  catalogReady: sessionRef.current.catalogReady,
                  namespace,
                  jobStatus: jobStatusRef.current,
                  jobError: jobErrorRef.current,
                }),
              );
            }
            return;
          }
          if (firstMediaAtMs === 0) {
            firstMediaAtMs = Date.now();
          }
          watchdogTick += 1;
          // Early-join freeze: kick play / hold the session. Do not tear
          // down — LOC reconnect RESET_STREAMs the publisher; CMAF reconnect
          // drops the one-shot catalog and resets vt to 0.
          const earlyWindow = Date.now() - firstMediaAtMs < EARLY_JOIN_WINDOW_MS;
          const stallLimitMs = earlyWindow ? EARLY_STALL_RESTART_MS : STALL_RESTART_MS;
          if (mediaPackaging === "loc") {
            const frames = sessionRef.current.framesRendered;
            const locStallMs = earlyWindow ? 3_000 : STALL_RESTART_MS;
            if (frames > lastLocFrames) {
              lastLocFrames = frames;
              watchdogAtMs = Date.now();
            }
            const locAction = classifyLocFrameStall({
              framesRendered: frames,
              lastAdvanceAtMs: watchdogAtMs,
              nowMs: Date.now(),
              sessionRestarts,
              stallLimitMs: locStallMs,
              retrying,
              earlyWindow,
              encodeFinished:
                jobStatusRef.current === "completed" || jobStatusRef.current === "failed",
            });
            if (locAction === "hold") {
              pushDiag(`loc_frames_hold frames=${frames}${earlyWindow ? " early_join" : ""}`);
              watchdogAtMs = Date.now();
              try {
                playerRef.current?.play();
              } catch {
                // ignore
              }
              return;
            }
            if (locAction === "restart") {
              watchdogAtMs = Date.now();
              scheduleSessionRestart(
                `loc_frames_frozen_${frames}${earlyWindow ? "_early_join" : ""}`,
                SESSION_RESTART_DELAY_MS,
              );
            } else if (locAction === "give_up" && !watchdogGaveUp) {
              watchdogGaveUp = true;
              pushDiag(`loc_stalled_frames=${frames} (gave up reconnects)`);
            }
            return;
          }
          if (retrying || userPausedRef.current) {
            // Reconnect in flight / user pause: don't count frozen time.
            // Do NOT treat video.paused as a free pass — MSE/playa often
            // pause after a stall, which used to disable the watchdog and
            // hide the crash as "Playback OK" when the encode later ended.
            watchdogVt = -1;
            watchdogAtMs = Date.now();
          } else if (video.currentTime > watchdogVt + 0.2) {
            watchdogVt = video.currentTime;
            watchdogAtMs = Date.now();
          } else if (Date.now() - watchdogAtMs > GAP_JUMP_AFTER_MS) {
            // Small-gap escape BEFORE any restart machinery: CMAF fragment
            // boundaries can leave sub-second holes in the MSE buffer that
            // freeze the playhead with plenty of media queued right behind
            // them (webcam run 2026-08-08 23:45: two 2s freezes per leg with
            // 4-8s buffered). Hop over the hole instead of waiting for the
            // stall watchdog to burn a session restart.
            let jumped = false;
            for (let i = 0; i < video.buffered.length; i += 1) {
              const start = video.buffered.start(i);
              if (
                start > video.currentTime + 0.01 &&
                start - video.currentTime <= GAP_JUMP_MAX_HOLE_SEC &&
                video.buffered.end(i) > start + 0.25
              ) {
                pushDiag(
                  `gap_jump from=${video.currentTime.toFixed(2)} to=${start.toFixed(2)} hole=${(start - video.currentTime).toFixed(2)}s`,
                );
                video.currentTime = start + 0.05;
                watchdogVt = -1;
                watchdogAtMs = Date.now();
                jumped = true;
                break;
              }
            }
            if (!jumped && Date.now() - watchdogAtMs > stallLimitMs) {
              const aheadNow = bufferedAheadSec(video);
              const cmafAction = classifyCmafPlayheadStall({
                videoTimeSec: video.currentTime,
                aheadSec: aheadNow,
                frozenMs: Date.now() - watchdogAtMs,
                earlyWindow,
                sessionRestarts,
                stallLimitMs,
                retrying,
              });
              if (cmafAction === "hold") {
                // Prod 0b1e1ac: vt=2.97s ahead=0.53s early_join — a GOP-sized
                // live-edge hold, not a dead session. Kick play(); do not
                // destroy the one-shot catalog.
                pushDiag(
                  `playhead_frozen_hold vt=${video.currentTime.toFixed(2)}s ahead=${aheadNow.toFixed(2)}s`,
                );
                watchdogAtMs = Date.now();
                try {
                  playerRef.current?.play();
                } catch {
                  // ignore
                }
                void video.play().catch(() => undefined);
                return;
              }
              if (cmafAction === "restart") {
                watchdogVt = -1;
                watchdogAtMs = Date.now();
                scheduleSessionRestart(
                  `playhead_frozen_${video.currentTime.toFixed(2)}s${earlyWindow ? "_early_join" : ""}`,
                  SESSION_RESTART_DELAY_MS,
                );
                return;
              }
              if (cmafAction === "give_up" && !watchdogGaveUp) {
                watchdogGaveUp = true;
                fail(
                  `MoQ playback stalled at ${video.currentTime.toFixed(1)}s and did not recover after ${MAX_SESSION_RESTARTS} reconnects.`,
                );
                return;
              }
            }
          }
          // Rate-based catch-up runs on every 500ms tick — fine cadence keeps
          // the rate transitions (and thus perceived motion) smooth. The rate
          // scales with overshoot: fixed 1.08/1.12 steps could not outrun the
          // drift a couple of stall-freezes leave behind (webcam run
          // 2026-08-08 23:45: e2e climbed 2.4s -> 9.5s over ~50s).
          const ahead = bufferedAheadSec(video);
          const previousRate = catchUpRate;
          if (ahead > rateOnSec) {
            const overshoot = Math.min(1, (ahead - rateOnSec) / (seekThresholdSec - rateOnSec));
            const raw = 1 + (MAX_CATCH_UP_RATE - 1) * Math.max(overshoot, 0.3);
            catchUpRate = Math.round(raw * 20) / 20; // quantize to 0.05 steps
          } else if (ahead < rateOffSec) {
            catchUpRate = 1;
          }
          if (catchUpRate !== previousRate) {
            pushDiag(
              `live_edge_rate=${catchUpRate.toFixed(2)} ahead=${ahead.toFixed(2)}s hold=${holdBehindSec.toFixed(2)}s`,
            );
          }
          if (Math.abs(video.playbackRate - catchUpRate) > 0.01) {
            video.playbackRate = catchUpRate;
          }
          // Hard seek stays on its original 2s cadence; seeking on every
          // 500ms watchdog tick would fight normal per-GOP buffer bursts.
          if (watchdogTick % liveEdgeTickDivider !== 0) {
            return;
          }
          if (ahead < seekThresholdSec) {
            return;
          }
          // Pass our threshold explicitly — the helper's internal default
          // (hold x 2.5) was stricter than this gate, so buffer leads between
          // the two thresholds never seeked and latency ratcheted upward.
          if (seekNearLiveEdge(video, holdBehindSec, seekThresholdSec)) {
            pushDiag(`live_edge_seek ahead=${ahead.toFixed(2)}s hold=${holdBehindSec.toFixed(2)}s`);
          }
        }, WATCHDOG_TICK_MS);
      } catch (err) {
        playerRef.current?.destroy();
        playerRef.current = null;
        setIsReady(false);
        if (!destroyed) {
          const message =
            err instanceof Error
              ? err.message
              : "MoQ connection failed. Use Chrome/Edge and verify the relay publish is live.";
          fail(message);
        }
      }
    }

    void start();

    return () => {
      // eslint-disable-next-line no-console
      console.log(`[MoqPlayer] live-effect cleanup #${mountNumber}`);
      destroyed = true;
      persistJobRebuffer(jobId, rebufferRef.current);
      detachHtmlMonitors();
      diagReporter.stop();
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (connectTimeout) {
        window.clearTimeout(connectTimeout);
      }
      if (liveEdgeTimer) {
        window.clearInterval(liveEdgeTimer);
      }
      if (playKickTimer) {
        window.clearInterval(playKickTimer);
      }
      if (decodeKickTimer) {
        window.clearTimeout(decodeKickTimer);
      }
      setIsReady(false);
      const active = playerRef.current;
      playerRef.current = null;
      active?.destroy();
    };
    // encodeDurationSec is read once at start for catalog timeout — keep it out of
    // deps so a late duration update does not tear down a healthy Player/MediaSource.
  }, [relayUrl, namespace, fingerprintUrl, playbackGate, pinTlsCert, jobId, targetLatencyMs, sourceHasAudio, draftVersion, mediaPackaging]);

  async function togglePlayPause() {
    const player = playerRef.current;
    if (!player || !isReady) {
      return;
    }
    // Pause before the first frame sends forward:0 at the relay and the
    // live objects stop. Until then, Play only starts decode.
    if (isPlaying && sessionRef.current.firstFrame) {
      userPausedRef.current = true;
      player.pause();
      setIsPlaying(false);
      setStatus("Paused");
      return;
    }
    userPausedRef.current = false;
    player.play();
    setIsPlaying(true);
    setStatus("Playing");
  }

  return (
    <div className="player-surface">
      <canvas ref={canvasRef} className="player-canvas" />
      <video ref={videoRef} className="player-video" playsInline muted autoPlay hidden />
      <div className="player-controls">
        <button
          type="button"
          className="ghost-button"
          disabled={playbackGate !== "live" || !isReady}
          onClick={() => void togglePlayPause()}
        >
          {isPlaying && sessionRef.current.firstFrame ? "Pause" : "Play"}
        </button>
      </div>
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
      </div>
      {error && <p className="player-error">{error}</p>}
      <PlayerDiagnostics
        engine="moq"
        playbackGate={playbackGate}
        jobStatus={jobStatus}
        benchmarkLoading={benchmarkLoading}
        status={status}
        error={error ?? lastErrorRef.current}
        lines={diagLines}
      />
    </div>
  );
}
