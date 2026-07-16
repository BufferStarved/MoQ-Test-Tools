import { useCallback, useEffect, useRef, useState } from "react";
import { Player } from "@playa/player";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { OPENMOQ_BENCHMARK_CATALOG } from "../moqOpenmoqCatalog";
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
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const PUBLISHER_WARMUP_MS = 6_000;
const SUBSCRIBE_RETRY_MS = 5_000;
const MAX_CONNECT_ATTEMPTS = 2;
const MOQ_ALL_TRACKS_REFUSED = 4867;

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
  });
  // Survives across effect re-mounts (unlike pinnedDiagRef, which start()
  // clears). Lets us tell from the UI alone whether the "live" effect fired
  // more than once for this component instance — e.g. because `namespace`
  // arrived late and changed identity after the gate flipped to "live",
  // which would create two Player/MediaSource instances against the same
  // <video> element and could explain spurious "SourceBuffer removed" errors.
  const mountCountRef = useRef(0);

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => ({
      playback_stats_events: sessionRef.current.statsEvents,
      playback_stall_count: sessionRef.current.stallCount,
      playback_frames_rendered: sessionRef.current.framesRendered,
      playback_frames_dropped: sessionRef.current.framesDropped,
      playback_bitrate_bps: sessionRef.current.bitrateBps,
      playback_ttff_ms: sessionRef.current.ttffMs,
      playback_hls_errors: 0,
      playback_hls_fatal_errors: 0,
      playback_hls_buffer_stalls: 0,
      playback_hls_frag_loads: 0,
      playback_video_time_sec: sessionRef.current.videoTimeSec,
    }),
    [],
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
        if (sessionRef.current.firstFrame) {
          setError(null);
          setStatus("Playback OK");
        } else if (lastErrorRef.current) {
          setError(lastErrorRef.current);
          setStatus("Failed (see diagnostics)");
        } else if (sessionRef.current.catalogReady) {
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
    };

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

    function onTimeUpdate() {
      if (destroyed || sessionRef.current.firstFrame) {
        return;
      }
      if (video.currentTime > 0.25) {
        sessionRef.current.firstFrame = true;
        sessionRef.current.videoTimeSec = Math.max(
          sessionRef.current.videoTimeSec,
          video.currentTime,
        );
        if (connectTimeout) {
          window.clearTimeout(connectTimeout);
        }
        pushDiag(
          `first_frame=ok video_time=${video.currentTime.toFixed(2)} size=${video.videoWidth}x${video.videoHeight}`,
        );
        setIsPlaying(true);
        setStatus("Playing");
      }
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
      pushDiag("catalog_mode=injected openmoq vide_1+soun_2", true);
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

        const player = new Player(null, {
          url: relayUrl,
          namespace,
          draftVersion: 16,
          certHash,
          canvas,
          video,
          muted: true,
          autoplay: true,
          targetLatencyMs: 500,
          moqtPlayerConfig: {
            catalog: OPENMOQ_BENCHMARK_CATALOG,
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
          if (video.currentTime > 0.25 && video.videoWidth > 0) {
            sessionRef.current.firstFrame = true;
            if (connectTimeout) {
              window.clearTimeout(connectTimeout);
            }
            pushDiag(
              `first_frame=ok video_time=${video.currentTime.toFixed(2)} size=${video.videoWidth}x${video.videoHeight}`,
            );
            setIsPlaying(true);
            setStatus("Playing");
          }
        });

        player.on("stall", ({ durationMs }) => {
          sessionRef.current.stallCount += 1;
          pushDiag(`stall_ms=${durationMs}`);
        });

        player.on("timeupdate", ({ currentTime }) => {
          // @playa/player reports MoQ media-timeline PTS here (often 10k+), not <video> clock.
          if (destroyed) {
            return;
          }
          if (video.currentTime > 0.25 && video.videoWidth > 0) {
            sessionRef.current.firstFrame = true;
            setIsPlaying(true);
            setStatus("Playing");
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
          if (stats.framesRendered > 0) {
            sessionRef.current.statsEvents += 1;
            sessionRef.current.firstFrame = true;
            pushDiag(
              `stats bitrate=${stats.bitrate} latency=${stats.latencyMs} ttf=${stats.timeToFirstFrameMs ?? 0} rendered=${stats.framesRendered}`,
            );
            setIsPlaying(true);
            setStatus("Playing");
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
      setIsReady(false);
      const active = playerRef.current;
      playerRef.current = null;
      active?.destroy();
    };
  }, [relayUrl, namespace, fingerprintUrl, playbackGate, pinTlsCert, encodeDurationSec]);

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
      <video ref={videoRef} className="player-video" controls playsInline muted hidden />
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
