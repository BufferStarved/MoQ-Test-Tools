import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { resolvePlaybackXhrUrl } from "../playbackFetch";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
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
  /** Derived from upload target latency (segment-count fallback). */
  liveSyncDurationCount?: number;
  /** Intentional live buffer in seconds (preferred over count). Default ~4s. */
  liveSyncDurationSec?: number;
}

const MANIFEST_POLL_MS = 400;
const MANIFEST_POLL_MAX = 120;
/**
 * Start as soon as a segment URI exists. Waiting for MEDIA-SEQUENCE advance
 * cost ~20s when Zixi long-polls empty playlists. Stale single-segment loops
 * are corrected by seeking to hls.liveSyncPosition when the playlist jumps.
 */
const MANIFEST_START_POLLS = 2;
const MANIFEST_STUCK_POLLS = 60;
const STALE_FRAG_FAIL_AFTER = 8;
/** Only jump when clearly stuck behind; aggressive jumps on 1-deep playlists stutter. */
const LIVE_JUMP_BEHIND_SEC = 4;
const LIVE_JUMP_BEHIND_SHALLOW_SEC = 6;

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

function playlistDepth(body: string): number {
  return body.split("\n").filter((row) => {
    const line = row.trim();
    return Boolean(line) && !line.startsWith("#");
  }).length;
}

function playlistTargetDurationSec(body: string): number {
  const match = body.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
  if (!match) {
    return 2;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : 2;
}

/**
 * Zixi often advertises playback.ts?chunk=N in the playlist before that
 * chunk is actually readable (HTTP 400 Bad Request). Starting hls.js then
 * loops fragLoadError forever. Require a real MPEG-TS body before go-live.
 *
 * Playlists rewritten by /api/playback/fetch already contain
 * `/api/playback/fetch?url=...` segment lines — resolve those against the
 * local app origin. Never resolve them against the Zixi host (that produces
 * http://zixi/api/playback/fetch?... and a 500 double-proxy loop).
 */
async function segmentFetchable(manifestRemoteUrl: string, segmentLine: string): Promise<boolean> {
  try {
    const fetchUrl = resolvePlaybackXhrUrl(
      segmentLine.includes("/api/playback/fetch")
        ? segmentLine.startsWith("http")
          ? segmentLine
          : new URL(segmentLine, window.location.origin).href
        : new URL(segmentLine, manifestRemoteUrl).href,
    );
    const response = await fetch(fetchUrl, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // MPEG-TS packets start with sync byte 0x47; require at least one packet.
    return bytes.byteLength >= 188 && bytes[0] === 0x47;
  } catch {
    return false;
  }
}

/** Live sync in seconds, clamped to what the playlist depth can actually hold. */
function hlsSyncDurationForPlaylist(body: string, requestedSec: number): number {
  const depth = playlistDepth(body);
  const targetDuration = playlistTargetDurationSec(body);
  const requested = Math.max(1, Math.min(20, requestedSec || 4));
  if (depth <= 1) {
    return Math.min(requested, targetDuration);
  }
  const maxHold = Math.max(targetDuration, (depth - 1) * targetDuration);
  return Math.max(1, Math.min(requested, maxHold));
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
          const depth = playlistDepth(body);
          const candidate =
            depth >= 2 ||
            (Boolean(sequence && previousSequence && sequence !== previousSequence)) ||
            (Boolean(segment && previousSegment && segment !== previousSegment)) ||
            (Boolean(segment && attempt >= MANIFEST_START_POLLS));

          let segmentReady = false;
          if (candidate && segment) {
            segmentReady = await segmentFetchable(url, segment);
          }

          onAttempt(
            attempt,
            [
              sequence ? `media_sequence=${sequence}` : "media_sequence=unknown",
              `depth=${depth}`,
              segment ? `segment_ready=${segmentReady ? "yes" : "no"}` : "segment=none",
            ].join(" "),
          );

          if (candidate && segmentReady) {
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
          } else {
            unchangedPolls = 0;
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
  liveSyncDurationCount = 2,
  liveSyncDurationSec,
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
    ttffMs: 0,
    liveStartedAtMs: 0,
    bufferSec: 0,
  });
  const rebufferRef = useRef(new RebufferTracker());

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => ({
      playback_stats_events: 0,
      playback_stall_count: sessionRef.current.hlsBufferStalls,
      playback_frames_rendered: 0,
      playback_frames_dropped: 0,
      playback_bitrate_bps: 0,
      playback_ttff_ms: sessionRef.current.ttffMs,
      playback_hls_errors: sessionRef.current.hlsErrors,
      playback_hls_fatal_errors: sessionRef.current.hlsFatalErrors,
      playback_hls_buffer_stalls: sessionRef.current.hlsBufferStalls,
      playback_hls_frag_loads: sessionRef.current.fragmentLoads,
      playback_video_time_sec: sessionRef.current.maxVideoTime,
      playback_buffer_sec: sessionRef.current.bufferSec,
      playback_rebuffer_sec: rebufferRef.current.totalSec,
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
          playbackGate === "waiting"
            ? "Waiting for readable HLS segments..."
            : "Waiting for encode...",
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
      ttffMs: 0,
      liveStartedAtMs: Date.now(),
      bufferSec: 0,
    };
    rebufferRef.current.reset();

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
              `Zixi HLS never served a readable MPEG-TS segment while the playlist listed chunk N (HTTP 400). For SRT, confirm the shared "SRT Test" input was reset and that media_sequence advances — check diagnostics for segment_ready=yes.`,
            );
          }
        },
      );

      if (destroyed) {
        return;
      }
      if (!manifestBody) {
        fail(
          "HLS never became playable during the encode (playlist appeared but segments stayed HTTP 400). Zixi needs a few seconds after the first SRT packets before chunk N is readable — check diagnostics for segment_ready=yes.",
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

      // Prefer duration (seconds): default 2×2s = 4s; floor at one segment.
      const depth = playlistDepth(manifestBody);
      const targetDuration = playlistTargetDurationSec(manifestBody);
      const shallow = depth <= 1;
      const requestedSec =
        liveSyncDurationSec ??
        Math.max(targetDuration, (liveSyncDurationCount || 2) * Math.max(2, targetDuration));
      // Never sync tighter than one TARGETDURATION on non-LL Zixi packs.
      const syncSec = Math.max(
        targetDuration,
        hlsSyncDurationForPlaylist(manifestBody, requestedSec),
      );
      const syncCount = Math.max(1, Math.round(syncSec / Math.max(1, targetDuration)));
      const hls = new Hls({
        enableWorker: true,
        // Zixi HLS is not LL-HLS; lowLatencyMode + tight sync caused buffer stalls.
        lowLatencyMode: false,
        // Use segment counts (more reliable than liveSyncDuration on 1-deep Zixi).
        liveSyncDurationCount: syncCount,
        liveMaxLatencyDurationCount: shallow
          ? Math.max(syncCount + 2, 3)
          : Math.max(syncCount + 3, syncCount * 2),
        // Speed-up catch-up on a shallow window just empties the only segment.
        maxLiveSyncPlaybackRate: shallow ? 1.0 : 1.5,
        // Hold enough media for 2-segment operation; more when shallow.
        maxBufferLength: shallow ? 30 : Math.max(20, syncSec * 3),
        maxMaxBufferLength: shallow ? 60 : 40,
        backBufferLength: 30,
        // Proxy manifest timeout is 5s (Zixi long-poll) — client timeout must
        // clear that with margin, or hls.js fires a fatal error mid-request.
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 300,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 300,
        fragLoadingTimeOut: 15000,
        fragLoadingMaxRetry: 4,
        xhrSetup(xhr, requestUrl) {
          const resolved = resolvePlaybackXhrUrl(requestUrl);
          lastRequestUrl = resolved;
          xhr.open("GET", resolved);
        },
      });
      pushDiag(
        `hls_live_sync=${syncCount}seg (~${syncSec.toFixed(1)}s) targetduration=${targetDuration}s depth=${depth} shallow=${shallow ? 1 : 0} ll_mode=off`,
      );
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

      // When Zixi finally rolls past a stale edge, jump to live instead of
      // draining a multi-second backlog. On 1-deep playlists, jump less often —
      // seeking to the only segment mid-decode causes visible stutters.
      hls.on(Hls.Events.LEVEL_UPDATED, () => {
        if (destroyed) {
          return;
        }
        const liveSync = hls.liveSyncPosition;
        if (
          liveSync == null ||
          !Number.isFinite(liveSync) ||
          video.readyState < 2 ||
          video.currentTime <= 0
        ) {
          return;
        }
        const behind = liveSync - video.currentTime;
        const jumpThreshold = shallow ? LIVE_JUMP_BEHIND_SHALLOW_SEC : LIVE_JUMP_BEHIND_SEC;
        if (behind >= jumpThreshold) {
          video.currentTime = liveSync;
          pushDiag(`hls_live_jump behind=${behind.toFixed(2)}s to=${liveSync.toFixed(2)}`);
        }
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

        // End-of-stream: Zixi tears down the input; playlist refresh can 404 or
        // return an unparseable body. If we already played video, treat as EOS.
        const parseEos =
          data.details === Hls.ErrorDetails.LEVEL_PARSING_ERROR ||
          data.details === Hls.ErrorDetails.LEVEL_EMPTY_ERROR ||
          data.response?.code === 404;
        if (parseEos && hlsPlaybackOk(sessionRef.current)) {
          pushDiag("eos_graceful=playlist_gone_after_playback_ok");
          try {
            hls.stopLoad();
          } catch {
            /* ignore */
          }
          setError(null);
          lastErrorRef.current = null;
          setStatus("Playback OK");
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
      video.addEventListener("playing", () => {
        noteVideoProgress("playing");
        rebufferRef.current.endWait();
      });
      video.addEventListener("waiting", () => {
        rebufferRef.current.beginWait(sessionRef.current.ttffMs > 0);
      });
      video.addEventListener("timeupdate", () => {
        if (destroyed) {
          return;
        }
        sessionRef.current.maxVideoTime = Math.max(
          sessionRef.current.maxVideoTime,
          video.currentTime,
        );
        sessionRef.current.bufferSec = bufferedAheadSec(video);
        if (sessionRef.current.ttffMs <= 0 && video.currentTime > 0.25) {
          sessionRef.current.ttffMs = Math.max(
            0,
            Date.now() - sessionRef.current.liveStartedAtMs,
          );
          pushDiag(`ttff_ms=${sessionRef.current.ttffMs}`);
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
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay />
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
