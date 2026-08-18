import { useCallback, useEffect, useRef, useState } from "react";
import { Player } from "@playa/player";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { browserLocCatalogTracks } from "../browserMoq/locCatalog";
import { createStrictMoqtTransport } from "../browserMoq/webTransport";
import { OPENMOQ_AUDIO_TRACK, OPENMOQ_VIDEO_TRACK } from "../moqOpenmoqCatalog";
import { moqCatchUpConfig } from "../encodeProfiles";
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
import { usePlaybackMetricsReporter } from "../playbackMetrics";
import {
  attachHtmlPlaybackMonitors,
  loadJobRebuffer,
  persistJobRebuffer,
  readVideoFrameStats,
} from "../videoPlaybackMetrics";
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
const SUBSCRIBE_RETRY_MS = 1_500;
/** Cover publisher startup (namespace 0x10) without waiting past catalog publish. */
const MAX_CONNECT_ATTEMPTS = 12;
/** If SUBSCRIBE_OK arrived after catalog group 0, tear down and resubscribe. */
const CATALOG_RETRY_MS = 4_000;
const MOQ_ALL_TRACKS_REFUSED = 4867;
const MOQ_SUBSCRIPTION_REFUSED = 4866;
const MOQ_LOAD_FAILED = 4865;

function isPublisherNotReadyError(code: number): boolean {
  return (
    code === MOQ_ALL_TRACKS_REFUSED ||
    code === MOQ_SUBSCRIPTION_REFUSED ||
    code === MOQ_LOAD_FAILED
  );
}

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
// CMAF/NextGroupStart: moqx sometimes honors a mid-stream subscribe for
// exactly one group then never attaches later groups — recover with a
// fast resubscribe. LOC uses LargestObject; fan-out on the publisher means
// a player resubscribe no longer steals the ingest recorder's alias.
const EARLY_JOIN_WINDOW_MS = 15_000;
const EARLY_STALL_RESTART_MS = 1_750;
const EARLY_RESTART_DELAY_MS = 250;
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
  benchmarkLoading = false,
  encodeDurationSec = 30,
  targetLatencyMs = 400,
  sourceHasAudio = true,
  bridgeLagMs = 0,
  encoderLagMs = 0,
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
    // Latest MoQ media-timeline position (ms) from playa's timeupdate — the
    // LEG ENCODER's output timeline (fMP4 tfdt starts ~0 at encode start),
    // unlike video.currentTime which MSE re-zeroes at join. This is what
    // makes a capture-anchored latency possible: wall-since-encode minus
    // this position minus nothing else = encoder->glass.
    moqTimelineMs: 0,
  });
  const rebufferRef = useRef(new RebufferTracker());
  const lagRef = useRef({ bridgeMs: 0, encoderMs: 0, epoch: 0 });
  lagRef.current = {
    bridgeMs: bridgeLagMs,
    encoderMs: encoderLagMs,
    epoch: encodeStartedAtEpoch ?? 0,
  };
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
   * Capture-anchored glass-to-glass estimate (ms) — the same unified
   * formula as the HLS/HTTP-TS players:
   *
   *   e2e = (server-clock now − encode anchor) − encoder-timeline playhead + bridge
   *
   * The MSE `<video>` clock re-zeros at join, so `video.currentTime` alone
   * is useless here — but playa's assembler records the raw tfdt of the
   * first appended segment (`joinMediaOffsetSec`), and `joinOffset +
   * currentTime` IS the playhead on the encoder's timeline (tfdt starts ~0
   * at encode start for a live encode). Wall time is skew-corrected to the
   * API server's clock, which stamps the anchor epochs.
   *
   * Fallbacks, in order: playa's CaptureTimestamp latency when reported,
   * then the old buffer-lead proxy (buffered media + decode/render pad).
   * encode_lag_ms is deliberately NOT added: it is a baseline-subtracted
   * "encoder falling behind" gauge, and the old raw form summed ~1.2-2.4s
   * of one-time startup offset into every sample.
   */
  function captureAnchoredE2eMs(): number | undefined {
    const session = sessionRef.current;
    const { bridgeMs, epoch } = lagRef.current;
    const video = videoRef.current;

    if (mediaPackaging === "loc") {
      // Playa timeupdate on canvas is playbackDuration (wall clock), not
      // encoder media time — using it as the playhead made e2e 0. Prefer
      // CaptureTimestamp latency when playa reports it; otherwise count
      // rendered frames so a freeze shows up as rising latency.
      if (session.playerLatencyMs > 10 && session.playerLatencyMs < 30_000) {
        const total = session.playerLatencyMs + bridgeMs;
        if (total > 0 && total < 120_000) {
          return Math.round(total);
        }
      }
      if (session.videoTimeSec > 0.05 && epoch > 0) {
        const total =
          Date.now() + clockSkewMs() - epoch * 1000 - session.videoTimeSec * 1000 + bridgeMs;
        if (total > 0 && total < 120_000) {
          return Math.round(total);
        }
      }
    }

    const joinOffsetSec = playerRef.current?.joinMediaOffsetSec ?? null;
    if (joinOffsetSec != null && video && video.currentTime > 0.05) {
      // joinOffset + currentTime is the playhead on the encoder's media
      // timeline (raw CMAF tfdt at join + MSE progress). Validated exact vs a
      // burnt-in timer 2026-08-09 (56.81 computed vs 56.70 on the glass).
      const mediaPosSec = joinOffsetSec + video.currentTime;
      if (mediaPosSec > 1e6) {
        // Live webcam legs mux with -use_wallclock_as_timestamps: tfdt IS the
        // capture wall epoch (at the leg encoder's demux), so no anchor is
        // needed at all — difference against the (skew-corrected) wall clock.
        const total = Date.now() + clockSkewMs() - mediaPosSec * 1000 + bridgeMs;
        if (total > 0 && total < 120_000) {
          return Math.round(total);
        }
      } else if (epoch > 0) {
        const total = Date.now() + clockSkewMs() - epoch * 1000 - mediaPosSec * 1000 + bridgeMs;
        if (total > 0 && total < 120_000) {
          return Math.round(total);
        }
      }
    }

    if (session.playerLatencyMs > 0) {
      const total = session.playerLatencyMs + bridgeMs;
      return total > 0 && total < 120_000 ? Math.round(total) : undefined;
    }
    if (!session.firstFrame) {
      return undefined;
    }
    const bufferMs = bufferedAheadSec(videoRef.current) * 1000;
    if (bufferMs <= 0) {
      return undefined;
    }
    const total = bufferMs + 250 + bridgeMs;
    return total > 0 && total < 120_000 ? Math.round(total) : undefined;
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

    if (playbackGate !== "live") {
      if (playbackGate === "ended") {
        const outcome = getMoqPlaybackOutcome(jobId);
        const playedOk =
          moqPlaybackSucceeded(jobId) ||
          sessionRef.current.firstFrame ||
          sessionRef.current.videoTimeSec > 0.25 ||
          sessionRef.current.ttffMs > 0;
        const catalogReady = Boolean(outcome?.catalogReady || sessionRef.current.catalogReady);
        if (playedOk) {
          setError(null);
          lastErrorRef.current = null;
          setStatus("Playback OK");
        } else if (lastErrorRef.current) {
          setError(lastErrorRef.current);
          setStatus("Failed (see diagnostics)");
        } else if (catalogReady) {
          const message = "MoQ catalog loaded but no video frames rendered during the encode.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        } else {
          const message =
            "MoQ catalog never loaded during the encode. Check API terminal for a line starting with 'MoQ publish via openmoq' during the run.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
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
    };
    // Remounts used to wipe rebuffer to 0 mid-run — restore per-job accum.
    rebufferRef.current.reset();
    loadJobRebuffer(jobId, rebufferRef.current);
    // LOC has no MSE <video> clock. The frozen-playhead monitor on a hidden
    // element counted a stall every ~800ms and the watchdog resubscribed —
    // that read as extreme chop, not as a bandwidth problem.
    const detachHtmlMonitors =
      mediaPackaging === "loc"
        ? () => undefined
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
      lastErrorRef.current = message;
      setError(message);
      setStatus("Failed");
      setIsReady(false);
      setIsPlaying(false);
      diagReporter.push(`FAIL ${message}`);
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
      const mediaType = player.activeMediaType;
      pushDiag(`media_sink=${mediaType ?? "unknown"}`);
      if (mediaType === "video") {
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
        setStatus(attempt === 1 ? "Connecting..." : "Retrying subscribe...");
        if (attempt > 1) {
          pushDiag(`subscribe_retry=attempt${attempt}`, true);
        }

        const catchUp = moqCatchUpConfig(targetLatencyMs || 400);
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
              ? { catalog: browserLocCatalogTracks({ includeAudio: sourceHasAudio }) }
              : {}),
            // LOC carries CaptureTimestamps; CMAF from openmoq does not.
            maxCatchUpRate: catchUp.maxCatchUpRate,
            catchUpThresholdMs: catchUp.catchUpThresholdMs,
            catchUpRecoveryMs: catchUp.catchUpRecoveryMs,
            // Default lateFrameThresholdMs is 100ms. Live MoQ e2e is hundreds
            // of ms, so Playa skipped every frame after the join cushion
            // (observed: ~36 rendered frames then a freeze while 2.2 Mbps
            // still arrived). Show a late frame rather than a black canvas.
            lateFrameThresholdMs: mediaPackaging === "loc" ? 5_000 : 400,
            // LOC: LargestObject + warm-start of the current GOP. NextGroupStart
            // on moqx delivered one group then froze (~1–2 fps with the
            // resubscribe watchdog). CMAF still joins on the next fragment.
            ...(mediaPackaging === "loc"
              ? {
                  subscriptionFilter: { type: "LargestObject" as const },
                  warmStartCurrentGroup: true,
                }
              : { subscriptionFilter: { type: "NextGroupStart" as const } }),
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
            setIsPlaying(true);
            setStatus("Playing");
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
            isPublisherNotReadyError(code) &&
            retrySubscribe("subscribe_retry=publisher_not_ready", SUBSCRIBE_RETRY_MS)
          ) {
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
          if (retrySubscribe("catalog_timeout_retry", 200)) {
            return;
          }
          fail(
            `MoQ catalog never loaded within ${catalogWaitSec}s after connect. Use Chrome (not Safari/Cursor). Publisher must be live on namespace ${namespace}.`,
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
        const liveEdgeTickDivider = Math.max(1, Math.round(LIVE_EDGE_TRIM_MS / WATCHDOG_TICK_MS));
        liveEdgeTimer = window.setInterval(() => {
          if (destroyed || !sessionRef.current.firstFrame) {
            return;
          }
          if (firstMediaAtMs === 0) {
            firstMediaAtMs = Date.now();
          }
          watchdogTick += 1;
          // First-join starvation fast path (see EARLY_STALL_RESTART_MS): a
          // freshly-joined subscription that delivered one group then went
          // silent is dead — resubscribing is the known-good recovery, so do
          // it in ~2s instead of letting the 8s watchdog turn a startup
          // hiccup into a ~12s freeze.
          const earlyWindow = Date.now() - firstMediaAtMs < EARLY_JOIN_WINDOW_MS;
          const stallLimitMs = earlyWindow ? EARLY_STALL_RESTART_MS : STALL_RESTART_MS;
          if (mediaPackaging === "loc") {
            const frames = sessionRef.current.framesRendered;
            const locStallMs = earlyWindow ? 3_000 : STALL_RESTART_MS;
            if (retrying) {
              watchdogAtMs = Date.now();
            } else if (frames > lastLocFrames) {
              lastLocFrames = frames;
              watchdogAtMs = Date.now();
            } else if (Date.now() - watchdogAtMs > locStallMs) {
              if (sessionRestarts < MAX_SESSION_RESTARTS) {
                watchdogAtMs = Date.now();
                scheduleSessionRestart(
                  `loc_frames_frozen_${frames}${earlyWindow ? "_early_join" : ""}`,
                  SESSION_RESTART_DELAY_MS,
                );
              } else if (!watchdogGaveUp) {
                watchdogGaveUp = true;
                pushDiag(`loc_stalled_frames=${frames} (gave up reconnects)`);
              }
            }
            return;
          }
          if (retrying || video.paused) {
            // Reconnect in flight / user pause: don't count frozen time.
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
              if (sessionRestarts < MAX_SESSION_RESTARTS) {
                watchdogVt = -1;
                watchdogAtMs = Date.now();
                scheduleSessionRestart(
                  `playhead_frozen_${video.currentTime.toFixed(2)}s${earlyWindow ? "_early_join" : ""}`,
                  earlyWindow ? EARLY_RESTART_DELAY_MS : SESSION_RESTART_DELAY_MS,
                );
              } else if (!watchdogGaveUp) {
                watchdogGaveUp = true;
                fail(
                  `MoQ playback stalled and did not recover after ${MAX_SESSION_RESTARTS} reconnects.`,
                );
              }
              return;
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
      player.pause();
      setIsPlaying(false);
      setStatus("Paused");
      return;
    }
    player.play();
    setIsPlaying(true);
    setStatus("Playing");
  }

  const gateMessage =
    playbackGate !== "live" ? playbackGateLabel(playbackGate, "moq") : null;

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
      {gateMessage && <p className="hint player-note">{gateMessage}</p>}
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
