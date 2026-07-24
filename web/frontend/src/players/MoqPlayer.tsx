import { useCallback, useEffect, useRef, useState } from "react";
import { Player } from "@playa/player";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { openmoqBenchmarkCatalog } from "../moqOpenmoqCatalog";
import { moqCatchUpConfig } from "../encodeProfiles";
import {
  markMoqCatalogReady,
  markMoqFirstFrame,
  moqPlaybackSucceeded,
  resetMoqPlaybackOutcome,
  getMoqPlaybackOutcome,
} from "../moqPlaybackOutcome";
import { bufferedAheadSec, RebufferTracker, seekNearLiveEdge } from "../playbackBuffer";
import { usePlaybackMetricsReporter } from "../playbackMetrics";
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
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Was 6s — that alone pinned wall−vt E2E near ~7s after join. Publisher is
// usually ready within ~1–2s of job start with injected catalog.
const PUBLISHER_WARMUP_MS = 1_500;
const SUBSCRIBE_RETRY_MS = 5_000;
// 2 attempts (~10s total patience) was too tight under real contention —
// ffmpeg+openmoq-publisher startup can lag past that when other comparison
// legs are also encoding on the same host. 4 attempts (~20s) stays well
// inside a typical job's duration.
const MAX_CONNECT_ATTEMPTS = 4;
const MOQ_ALL_TRACKS_REFUSED = 4867;
const LIVE_EDGE_TRIM_MS = 2_000;

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
   * Glass-to-glass estimate (ms). Prefer CaptureTimestamp when playa reports
   * it. Otherwise buffer lead + encode/bridge lag — never wall−MSE-currentTime
   * (join-zeroed; freezes at join delay and disagrees with ENC burn-in).
   */
  function captureAnchoredE2eMs(): number | undefined {
    const session = sessionRef.current;
    const { bridgeMs, encoderMs } = lagRef.current;
    if (session.playerLatencyMs > 0) {
      const total = session.playerLatencyMs + encoderMs + bridgeMs;
      return total > 0 && total < 120_000 ? Math.round(total) : undefined;
    }
    if (!session.firstFrame) {
      return undefined;
    }
    const bufferMs = bufferedAheadSec(videoRef.current) * 1000;
    if (bufferMs <= 0) {
      return undefined;
    }
    const total = bufferMs + 250 + encoderMs + bridgeMs;
    return total > 0 && total < 120_000 ? Math.round(total) : undefined;
  }

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => {
      const session = sessionRef.current;
      return {
        playback_stats_events: session.statsEvents,
        playback_stall_count: session.stallCount,
        playback_frames_rendered: session.framesRendered,
        playback_frames_dropped: session.framesDropped,
        playback_bitrate_bps: session.bitrateBps,
        playback_ttff_ms: session.ttffMs,
        playback_hls_errors: 0,
        playback_hls_fatal_errors: 0,
        playback_hls_buffer_stalls: 0,
        playback_hls_frag_loads: 0,
        playback_video_time_sec: session.videoTimeSec,
        playback_buffer_sec: bufferedAheadSec(videoRef.current),
        playback_rebuffer_sec: rebufferRef.current.totalSec,
        e2e_latency_ms: captureAnchoredE2eMs(),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  usePlaybackMetricsReporter({
    jobId,
    engine: "moq",
    enabled: playbackGate === "live",
    startedAtEpoch: encodeStartedAtEpoch,
    targetLatencyMs,
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
        `fingerprintUrl=${fingerprintUrl} pinTlsCert=${pinTlsCert} encodeDurationSec=${encodeDurationSec} jobStatus=${jobStatus} benchmarkLoading=${benchmarkLoading}`,
    );

    let destroyed = false;
    let connectTimeout: ReturnType<typeof window.setTimeout> | undefined;
    let liveEdgeTimer: ReturnType<typeof window.setInterval> | undefined;
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
    rebufferRef.current.reset();

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
    }

    function fail(message: string) {
      lastErrorRef.current = message;
      setError(message);
      setStatus("Failed");
      setIsReady(false);
      setIsPlaying(false);
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

    function noteFirstFrame(source: string) {
      if (destroyed || video.currentTime <= 0.25) {
        return;
      }
      const wasFirst = !sessionRef.current.firstFrame;
      sessionRef.current.firstFrame = true;
      sessionRef.current.videoTimeSec = Math.max(
        sessionRef.current.videoTimeSec,
        video.currentTime,
      );
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
        `first_frame=ok via=${source} video_time=${video.currentTime.toFixed(2)} size=${video.videoWidth}x${video.videoHeight}`,
      );
      setError(null);
      setIsPlaying(true);
      setStatus("Playing");
      // Defend against player/engine leaving a non-1.0 rate after false catch-up.
      if (Math.abs(video.playbackRate - 1) > 0.01) {
        pushDiag(`playback_rate_reset from=${video.playbackRate}`);
        video.playbackRate = 1;
      }
    }

    function onTimeUpdate() {
      if (destroyed) {
        return;
      }
      if (Math.abs(video.playbackRate - 1) > 0.01) {
        video.playbackRate = 1;
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
        `catalog_mode=injected openmoq vide_1${sourceHasAudio ? "+soun_2" : " (video-only source)"}`,
        true,
      );
      pushDiag(`publisher_forward=1 warmup=${PUBLISHER_WARMUP_MS / 1000}s`, true);
      setIsReady(false);

      let retrying = false;

      async function connectAndLoad(
        attempt: number,
        certHash: ArrayBuffer | undefined,
      ): Promise<void> {
        if (destroyed) {
          return;
        }

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
          draftVersion: 16,
          certHash,
          canvas,
          video,
          muted: true,
          autoplay: true,
          targetLatencyMs: catchUp.targetLatencyMs,
          // Catch-up + subscribe filter must go through moqtPlayerConfig —
          // @playa/player only forwards a subset of top-level options.
          moqtPlayerConfig: {
            catalog: openmoqBenchmarkCatalog(sourceHasAudio),
            // Catch-up disabled: openmoq CMAF has no LOC CaptureTimestamps.
            maxCatchUpRate: catchUp.maxCatchUpRate,
            catchUpThresholdMs: catchUp.catchUpThresholdMs,
            catchUpRecoveryMs: catchUp.catchUpRecoveryMs,
            // Next keyframe boundary — safer than LargestObject for fMP4 GOPs.
            subscriptionFilter: { type: "NextGroupStart" },
          },
        });
        playerRef.current = player;

        player.on("statechange", ({ state }) => {
          if (destroyed) {
            return;
          }
          pushDiag(`state=${state}`, state === "loading" || state === "error");
          if (state === "loading") {
            setIsPlaying(false);
            setStatus(attempt === 1 ? "Connecting..." : "Retrying subscribe...");
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
          if (video.videoWidth > 0) {
            noteFirstFrame("player.playing");
          }
        });

        player.on("stall", ({ durationMs }) => {
          sessionRef.current.stallCount += 1;
          rebufferRef.current.addSec(durationMs / 1000);
          pushDiag(`stall_ms=${durationMs}`);
        });

        player.on("timeupdate", ({ currentTime }) => {
          // With an active <video> sink, playa emits video.currentTime*1000
          // (MSE join-relative). Keep for diagnostics; e2e uses buffer lead.
          if (destroyed) {
            return;
          }
          if (currentTime > 0) {
            sessionRef.current.moqTimelineMs = currentTime;
          }
          if (video.currentTime > 0.25 && video.videoWidth > 0) {
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
          sessionRef.current.videoTimeSec = Math.max(
            sessionRef.current.videoTimeSec,
            video.currentTime,
          );
          if (typeof stats.latencyMs === "number" && stats.latencyMs > 0) {
            sessionRef.current.playerLatencyMs = stats.latencyMs;
          }
          if (stats.framesRendered > 0) {
            sessionRef.current.statsEvents += 1;
            if (video.currentTime > 0.25) {
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
          if (severity === "recoverable" || sessionRef.current.firstFrame) {
            return;
          }
          if (
            severity === "fatal" &&
            code === MOQ_ALL_TRACKS_REFUSED &&
            attempt < MAX_CONNECT_ATTEMPTS &&
            !retrying
          ) {
            retrying = true;
            void (async () => {
              pushDiag(`subscribe_retry=wait_${SUBSCRIBE_RETRY_MS / 1000}s publisher_not_ready`, true);
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
              await sleep(SUBSCRIBE_RETRY_MS);
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
          fail(
            `MoQ catalog never loaded within ${catalogWaitSec}s after connect. Use Chrome (not Safari/Cursor). Publisher must be live on namespace ${namespace}.`,
          );
        }, catalogWaitMs);
        updateMediaVisibility(player);
        if (player.state !== "playing") {
          try {
            await player.play();
          } catch {
            // autoplay may already be active
          }
        }
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
        pushDiag(certHash ? "tls_pin=ok" : "tls_pin=skipped", true);

        await connectAndLoad(1, certHash);
        if (destroyed) {
          return;
        }
        video.addEventListener("timeupdate", onTimeUpdate);
        // Keep playhead near live only when the buffer clearly balloons.
        // Aggressive seeks on a healthy ~0.5s buffer felt like stutter/slow-mo.
        const holdBehindSec = Math.max(0.4, (targetLatencyMs || 800) / 1000);
        liveEdgeTimer = window.setInterval(() => {
          if (destroyed || !sessionRef.current.firstFrame) {
            return;
          }
          const ahead = bufferedAheadSec(video);
          if (ahead < holdBehindSec * 4) {
            return;
          }
          if (seekNearLiveEdge(video, holdBehindSec)) {
            pushDiag(`live_edge_seek ahead=${ahead.toFixed(2)}s hold=${holdBehindSec.toFixed(2)}s`);
          }
        }, LIVE_EDGE_TRIM_MS);
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
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (connectTimeout) {
        window.clearTimeout(connectTimeout);
      }
      if (liveEdgeTimer) {
        window.clearInterval(liveEdgeTimer);
      }
      setIsReady(false);
      const active = playerRef.current;
      playerRef.current = null;
      active?.destroy();
    };
    // encodeDurationSec is read once at start for catalog timeout — keep it out of
    // deps so a late duration update does not tear down a healthy Player/MediaSource.
  }, [relayUrl, namespace, fingerprintUrl, playbackGate, pinTlsCert, jobId, targetLatencyMs, sourceHasAudio]);

  async function togglePlayPause() {
    const player = playerRef.current;
    if (!player || !isReady) {
      return;
    }
    if (player.state === "playing") {
      player.pause();
      setIsPlaying(false);
      setStatus("Paused");
      return;
    }
    await player.play();
    setIsPlaying(true);
    setStatus("Playing");
  }

  const gateMessage =
    playbackGate !== "live" ? playbackGateLabel(playbackGate, "moq") : null;

  return (
    <div className="player-surface">
      <canvas ref={canvasRef} className="player-canvas" />
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay hidden />
      <div className="player-controls">
        <button
          type="button"
          className="ghost-button"
          disabled={playbackGate !== "live" || !isReady}
          onClick={() => void togglePlayPause()}
        >
          {isPlaying ? "Pause" : "Play"}
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
