import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { resolvePlaybackXhrUrl } from "../playbackFetch";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { usePlaybackMetricsReporter } from "../playbackMetrics";
import { PlayerDiagnostics } from "./PlayerDiagnostics";

interface HlsPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  benchmarkLoading?: boolean;
}

const MANIFEST_POLL_MS = 1500;
const MANIFEST_POLL_MAX = 120;
/**
 * Require the playlist to advance (media_sequence or segment URI) before play.
 * A "stable" frozen playlist is the stale last-chunk loop — do not fall back to play.
 */
const MANIFEST_STUCK_POLLS = 28;
const STALE_FRAG_FAIL_AFTER = 4;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function mediaSequence(body: string): string | null {
  const match = body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  return match?.[1] ?? null;
}

function segmentUri(body: string): string | null {
  const line = body
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("#"));
  return line ?? null;
}

async function waitForManifest(
  url: string,
  shouldContinue: () => boolean,
  onAttempt: (attempt: number, detail: string) => void,
  onStuck?: (sequence: string) => void,
): Promise<string | null> {
  const manifestUrl = proxiedPlaybackUrl(url);
  let previousSequence: string | null = null;
  let previousSegment: string | null = null;
  let unchangedPolls = 0;
  for (let attempt = 1; attempt <= MANIFEST_POLL_MAX; attempt += 1) {
    if (!shouldContinue()) {
      return null;
    }
    try {
      const response = await fetch(manifestUrl, { cache: "no-store" });
      if (response.ok) {
        const body = await response.text();
        if (body.includes("#EXTM3U")) {
          const sequence = mediaSequence(body);
          const segment = segmentUri(body);
          onAttempt(
            attempt,
            sequence ? `media_sequence=${sequence}` : "media_sequence=unknown",
          );
          if (sequence && previousSequence && sequence !== previousSequence) {
            return body;
          }
          if (segment && previousSegment && segment !== previousSegment) {
            return body;
          }
          if (
            (sequence && previousSequence && sequence === previousSequence) ||
            (segment && previousSegment && segment === previousSegment)
          ) {
            unchangedPolls += 1;
            if (unchangedPolls >= MANIFEST_STUCK_POLLS) {
              onStuck?.(sequence ?? "unknown");
              return null;
            }
          }
          previousSequence = sequence ?? previousSequence;
          previousSegment = segment ?? previousSegment;
        }
      }
    } catch {
      // Retry while the encode spins up.
    }
    await sleep(MANIFEST_POLL_MS);
  }
  return null;
}

export default function HlsPlayer({
  url,
  label,
  playbackGate = "idle",
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  jobStatus,
  benchmarkLoading = false,
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for encode...");
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const lastErrorRef = useRef<string | null>(null);
  const sessionRef = useRef({
    fragmentLoads: 0,
    videoBuffers: 0,
    audioBuffers: 0,
    manifestParsed: false,
    uniqueFragUrls: new Set<string>(),
    maxVideoTime: 0,
    sawStaleFrag: false,
    sawBufferStall: false,
    hlsErrors: 0,
    hlsFatalErrors: 0,
    hlsBufferStalls: 0,
  });

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => ({
      playback_stats_events: 0,
      playback_stall_count: sessionRef.current.hlsBufferStalls,
      playback_frames_rendered: 0,
      playback_frames_dropped: 0,
      playback_bitrate_bps: 0,
      playback_ttff_ms: 0,
      playback_hls_errors: sessionRef.current.hlsErrors,
      playback_hls_fatal_errors: sessionRef.current.hlsFatalErrors,
      playback_hls_buffer_stalls: sessionRef.current.hlsBufferStalls,
      playback_hls_frag_loads: sessionRef.current.fragmentLoads,
      playback_video_time_sec: sessionRef.current.maxVideoTime,
    }),
    [],
  );

  usePlaybackMetricsReporter({
    jobId,
    engine: "hls",
    enabled: playbackGate === "live",
    startedAtEpoch: encodeStartedAtEpoch,
    getSnapshot: getPlaybackSnapshot,
    onSample: onPlaybackSample,
  });

  function hlsPlaybackOk(session: (typeof sessionRef)["current"]): boolean {
    // Successful decode/progress wins over transient early "stale" flags.
    return session.maxVideoTime > 0.25;
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (playbackGate !== "live") {
      if (playbackGate === "ended") {
        const session = sessionRef.current;
        const hadManifest = session.manifestParsed || session.fragmentLoads > 0;
        if (hlsPlaybackOk(session)) {
          setError(null);
          lastErrorRef.current = null;
          setStatus("Playback OK");
        } else if (lastErrorRef.current) {
          setError(lastErrorRef.current);
          setStatus("Failed (see diagnostics)");
        } else if (session.manifestParsed && session.videoBuffers === 0 && session.audioBuffers > 0) {
          const message =
            "HLS buffered audio only — video track never decoded. Zixi TS chunks are missing in-band SPS/PPS (ffprobe: non-existing PPS). Restart dev stack and re-encode; verify Server Probe shows probe_decode=ok.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        } else if (hadManifest && session.fragmentLoads > 0 && session.uniqueFragUrls.size <= 1) {
          const message =
            "HLS playlist stayed on one stale segment (chunk not advancing). Zixi HLS output is not rolling — run ./scripts/verify-zixi-srt-ingest.sh (must PASS). Fix Zixi HTTP :7777 HLS, not the browser player.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        } else if (hadManifest && session.fragmentLoads > 0 && session.maxVideoTime <= 0.25) {
          const message =
            "HLS segments downloaded but video never advanced past 0s. Segments may lack decodable H.264 keyframes at chunk boundaries.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        } else if (hadManifest) {
          const message = "HLS manifest loaded but no media segments were fetched during the encode.";
          lastErrorRef.current = message;
          setError(message);
          setStatus("Failed (see diagnostics)");
        } else {
          setStatus("Encode finished");
        }
      } else {
        setStatus(
          playbackGate === "waiting" ? "Waiting for live HLS..." : "Waiting for encode...",
        );
      }
      return;
    }

    if (jobStatus === "failed") {
      lastErrorRef.current =
        "SRT encode job failed (0 kbps). Restart ./scripts/dev.sh — API must use ffmpeg-full with libsrt.";
      setError(lastErrorRef.current);
      setStatus("Failed");
      return;
    }

    let destroyed = false;
    let hlsInstance: { destroy: () => void } | null = null;
    let lastRequestUrl = "";
    sessionRef.current = {
      fragmentLoads: 0,
      videoBuffers: 0,
      audioBuffers: 0,
      manifestParsed: false,
      uniqueFragUrls: new Set<string>(),
      maxVideoTime: 0,
      sawStaleFrag: false,
      sawBufferStall: false,
      hlsErrors: 0,
      hlsFatalErrors: 0,
      hlsBufferStalls: 0,
    };

    function pushDiag(line: string) {
      if (!destroyed) {
        setDiagLines((current) => [...current.slice(-12), line]);
      }
    }

    function fail(message: string) {
      lastErrorRef.current = message;
      setError(message);
      setStatus("Failed");
    }

    function noteVideoProgress(source: string) {
      const time = video.currentTime;
      sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, time);
      const { videoWidth, videoHeight } = video;
      pushDiag(
        `video_${source} time=${time.toFixed(2)} ready=${video.readyState} size=${videoWidth}x${videoHeight}`,
      );
      if (time > 0.25) {
        pushDiag("video_playback=ok");
      }
    }

    async function start() {
      setError(null);
      lastErrorRef.current = null;
      setDiagLines([]);
      setStatus("Waiting for live HLS manifest...");
      pushDiag(`manifest_target=${url}`);

      const manifestBody = await waitForManifest(
        url,
        () => !destroyed,
        (attempt, detail) => {
          if (!destroyed) {
            setStatus(`Waiting for live HLS manifest... (${attempt})`);
            pushDiag(`manifest_poll=${attempt} ${detail}`);
          }
        },
        (sequence) => {
          if (!destroyed) {
            pushDiag(`manifest_stuck=sequence_${sequence}`);
            fail(
              `Zixi HLS media_sequence stayed at ${sequence} for ~${Math.round((MANIFEST_STUCK_POLLS * MANIFEST_POLL_MS) / 1000)}s during the encode. Ingest may be live (check Zixi Connected + packets) — Zixi HLS packaging is slow or stalled. Restart ./scripts/dev.sh so uploads use direct ffmpeg→SRT.`,
            );
          }
        },
      );

      if (destroyed) {
        return;
      }
      if (!manifestBody) {
        fail(
          "HLS manifest never advanced during the encode. Zixi needs ~30s of stable SRT ingest before segments roll — ensure ./scripts/dev.sh was restarted after the latest upload fix.",
        );
        return;
      }

      pushDiag("manifest_preflight=ok");
      setStatus("Connecting...");
      const manifestUrl = proxiedPlaybackUrl(url);
      const Hls = (await import("hls.js")).default;
      if (destroyed) {
        return;
      }

      if (!Hls.isSupported()) {
        fail("HLS.js is not supported in this browser.");
        return;
      }

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Standard live HLS: stay ~2 segments behind the live edge so
        // playback does not underrun between segment rolls.
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        xhrSetup(xhr, requestUrl) {
          const resolved = resolvePlaybackXhrUrl(requestUrl);
          lastRequestUrl = resolved;
          xhr.open("GET", resolved);
        },
      });
      hlsInstance = hls;
      hls.loadSource(manifestUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) {
          return;
        }
        sessionRef.current.manifestParsed = true;
        pushDiag("hls_manifest_parsed=ok");
        setStatus("Playing");
        void video.play().catch(() => {
          fail("Autoplay blocked. Press play on the video controls.");
        });
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        sessionRef.current.fragmentLoads += 1;
        sessionRef.current.uniqueFragUrls.add(lastRequestUrl);
        const uniqueCount = sessionRef.current.uniqueFragUrls.size;
        // Only treat as stale after several loads of the *same* URL; clear once
        // the playlist advances (unique > 1). Early live HLS often repeats the
        // first chunk once before rolling — that must not poison the end verdict.
        const isStale =
          uniqueCount === 1 && sessionRef.current.fragmentLoads >= STALE_FRAG_FAIL_AFTER;
        sessionRef.current.sawStaleFrag = isStale;
        const stale = isStale ? " stale=yes" : "";
        pushDiag(
          `frag_loaded=${sessionRef.current.fragmentLoads} unique=${uniqueCount}${stale} last=${lastRequestUrl}`,
        );
        if (isStale && !destroyed) {
          fail(
            "Zixi HLS is looping a single stale segment (playlist not advancing). " +
              "The web host needs ZIXI_API_BASE/ZIXI_API_PASSWORD so each SRT push can reset the input.",
          );
          hls.destroy();
        }
      });

      hls.on(Hls.Events.BUFFER_APPENDED, (_event, data) => {
        if (destroyed) {
          return;
        }
        if (data.type === "video") {
          sessionRef.current.videoBuffers += 1;
        } else if (data.type === "audio") {
          sessionRef.current.audioBuffers += 1;
        }
        pushDiag(
          `buffer_appended=${data.type} video=${sessionRef.current.videoBuffers} audio=${sessionRef.current.audioBuffers}`,
        );
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed) {
          return;
        }
        sessionRef.current.hlsErrors += 1;
        if (data.fatal) {
          sessionRef.current.hlsFatalErrors += 1;
        }
        pushDiag(
          `hls_error fatal=${data.fatal ? "yes" : "no"} type=${data.type} details=${data.details} http=${data.response?.code ?? "-"}`,
        );
        if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
          pushDiag(`frag_error url=${data.frag?.url ?? lastRequestUrl}`);
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !data.fatal) {
          pushDiag("media_error_recoverable=trying");
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            sessionRef.current.sawBufferStall = true;
            sessionRef.current.hlsBufferStalls += 1;
          }
          hls.recoverMediaError();
        }
        if (!data.fatal) {
          return;
        }
        const detail =
          data.response?.code === 404
            ? "HLS segment or playlist not found. Is the stream still live on Zixi?"
            : data.type === Hls.ErrorTypes.MEDIA_ERROR
              ? "HLS decode failed. Segments may lack SPS/PPS at chunk boundaries."
              : data.type === Hls.ErrorTypes.NETWORK_ERROR
                ? `HLS network error loading ${data.frag?.url ?? "playlist"}.`
                : `HLS playback failed (${data.details ?? data.type}).`;
        fail(detail);
      });

      video.addEventListener("loadeddata", () => noteVideoProgress("loadeddata"));
      video.addEventListener("playing", () => noteVideoProgress("playing"));
      video.addEventListener("timeupdate", () => {
        if (!destroyed) {
          sessionRef.current.maxVideoTime = Math.max(
            sessionRef.current.maxVideoTime,
            video.currentTime,
          );
        }
      });
      video.addEventListener("error", () => {
        if (destroyed) {
          return;
        }
        const code = video.error?.code;
        const detail =
          code === MediaError.MEDIA_ERR_DECODE
            ? "Video decode failed after segments loaded (likely missing SPS/PPS in TS chunk)."
            : `Native video element error (code=${code ?? "?"}).`;
        fail(detail);
      });
    }

    void start();

    return () => {
      destroyed = true;
      hlsInstance?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, playbackGate, jobStatus]);

  const gateMessage =
    playbackGate !== "live" ? playbackGateLabel(playbackGate, "hls") : null;

  return (
    <div className="player-surface">
      <video ref={videoRef} className="player-video" controls playsInline muted />
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
      </div>
      {gateMessage && <p className="hint player-note">{gateMessage}</p>}
      {error && <p className="player-error">{error}</p>}
      <PlayerDiagnostics
        engine="hls"
        playbackGate={playbackGate}
        jobStatus={jobStatus}
        benchmarkLoading={benchmarkLoading}
        status={status}
        error={error ?? lastErrorRef.current}
        lines={diagLines}
        manifestUrl={url}
      />
    </div>
  );
}
