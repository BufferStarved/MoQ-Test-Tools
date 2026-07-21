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
  encodeLadder?: string;
  targetLatencyMs?: number;
  zixiStreamId?: string;
  /** Enable hls.js lowLatencyMode (MediaMTX Apple LL-HLS). */
  lowLatencyMode?: boolean;
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
/** Playhead frozen this long while data keeps buffering => escape the hole. */
const STUCK_PLAYHEAD_RESCUE_MS = 4000;
const STUCK_WATCHDOG_POLL_MS = 1000;

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
 * MediaMTX Apple LL-HLS serves a multivariant *master* playlist at
 * index.m3u8 (EXT-X-STREAM-INF + an audio EXT-X-MEDIA group) — the real
 * media playlist with segments/parts lives at a nested rendition URI. Zixi
 * Fast HLS never nests, so this is always false there.
 */
function isMultivariantPlaylist(body: string): boolean {
  return body.includes("#EXT-X-STREAM-INF");
}

/** First rendition playlist URI following an EXT-X-STREAM-INF tag (skips the
 * audio group's URI= attribute, which is not a standalone playlist line). */
function variantPlaylistUri(body: string): string | null {
  const lines = body.split("\n").map((row) => row.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (!candidate || candidate.startsWith("#")) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/**
 * Apple LL-HLS (fMP4/CMAF, e.g. MediaMTX) advertises its init segment via
 * EXT-X-MAP as soon as the muxer has a keyframe — that's the readiness
 * signal for this format. Classic Zixi Fast HLS (flat MPEG-TS) never emits
 * EXT-X-MAP, so this only ever fires for LL-HLS sources.
 */
function llHlsMapReady(body: string): boolean {
  return body.includes("#EXT-X-MAP");
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

async function fetchManifestBody(fetchUrl: string): Promise<string | null> {
  try {
    const response = await fetch(fetchUrl, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const body = await response.text();
    return body.includes("#EXTM3U") ? body : null;
  } catch {
    return null;
  }
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
      const topBody = await fetchManifestBody(manifestUrl);
      if (topBody) {
        let body = topBody;
        let mediaPlaylistUrl = url;

        // Follow a multivariant master playlist to its real media playlist
        // before running any of the readiness checks below.
        if (isMultivariantPlaylist(body)) {
          const variantUri = variantPlaylistUri(body);
          if (variantUri) {
            const variantAbsolute = new URL(variantUri, url).href;
            const variantBody = await fetchManifestBody(resolvePlaybackXhrUrl(variantAbsolute));
            if (variantBody) {
              body = variantBody;
              mediaPlaylistUrl = variantAbsolute;
            }
          }
        }

        const sequence = mediaSequence(body);
        const depth = playlistDepth(body);

        // Apple LL-HLS (fMP4/CMAF): ready once the init segment is known.
        // hls.js's own LL-HLS handling deals with EXT-X-GAP filler and
        // preload hints from here — the MPEG-TS byte probe below is
        // meaningless for fMP4 and would never pass.
        if (llHlsMapReady(body)) {
          onAttempt(
            attempt,
            [
              sequence ? `media_sequence=${sequence}` : "media_sequence=unknown",
              `depth=${depth}`,
              "ll_hls_map=ready",
            ].join(" "),
          );
          return body;
        }

        const segment = segmentUri(body);
        const candidate =
          depth >= 2 ||
          (Boolean(sequence && previousSequence && sequence !== previousSequence)) ||
          (Boolean(segment && previousSegment && segment !== previousSegment)) ||
          (Boolean(segment && attempt >= MANIFEST_START_POLLS));

        let segmentReady = false;
        if (candidate && segment) {
          segmentReady = await segmentFetchable(mediaPlaylistUrl, segment);
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
  encodeLadder,
  targetLatencyMs,
  zixiStreamId,
  lowLatencyMode = false,
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for encode...");
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const lastErrorRef = useRef<string | null>(null);
  const sessionRef = useRef({
    fragmentLoads: 0,
    videoBuffers: 0,
    audioBuffers: 0,
    manifestParsed: false,
    uniqueFragUrls: new Set<string>(),
    maxVideoTime: 0,
    // Managed Zixi SRT publishes advance MPEG-TS PTS with a monotonic
    // -output_ts_offset so the Fast HLS packager survives republish (see
    // src/zixi_ts_offset.py). That offset lands directly in
    // video.currentTime, so raw currentTime is an *absolute* stream-lifetime
    // position, not "seconds into this session" — on a long-lived shared
    // stream id this can read in the hours. Rebase to session-relative time
    // from the first currentTime we observe so metrics/UI reflect what the
    // viewer actually experienced in this run.
    videoTimeOrigin: null as number | null,
    sawStaleFrag: false,
    sawBufferStall: false,
    hlsErrors: 0,
    hlsFatalErrors: 0,
    hlsBufferStalls: 0,
    ttffMs: 0,
    liveStartedAtMs: 0,
    bufferSec: 0,
    // PDT-based latency from hls.js (now − playhead PROGRAM-DATE-TIME).
    // MediaMTX LL-HLS carries PDT; Zixi Fast HLS does not (stays 0).
    playerLatencyMs: 0,
  });

  // Zixi Fast HLS timelines are encode-anchored: with the per-run input
  // reset, raw currentTime IS media position since encode start, so the
  // wall−vt latency estimate must NOT rebase to the join position — that
  // inflated e2e by exactly the join offset (~3s vs burnt-in timer,
  // 2026-07-21: RTMP reported 10-11s while really ~7-8s). Rebase only when
  // the timeline is clearly shifted by a managed Zixi -output_ts_offset
  // (minutes/hours into a shared stream id).
  //
  // MediaMTX LL-HLS timelines start at an arbitrary muxer base (~10s), so
  // rebasing stays on there — its true latency comes from hls.js's
  // PDT-based `hls.latency` instead (see playerLatencyMs).
  const OFFSET_REBASE_THRESHOLD_SEC = 120;

  function sessionRelativeVideoTime(video: HTMLVideoElement): number {
    const session = sessionRef.current;
    const raw = video.currentTime;
    if (session.videoTimeOrigin == null) {
      if (raw > 0.05) {
        session.videoTimeOrigin =
          lowLatencyMode || raw > OFFSET_REBASE_THRESHOLD_SEC ? raw : 0;
      }
      return 0;
    }
    return Math.max(0, raw - session.videoTimeOrigin);
  }
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
      // PDT-derived true latency (hls.js `latency`), when the playlist
      // carries PROGRAM-DATE-TIME (MediaMTX LL-HLS). Preferred over the
      // wall−vt estimate, which is skewed by the join position.
      e2e_latency_ms: sessionRef.current.playerLatencyMs || undefined,
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
    let playRetryTimer: ReturnType<typeof window.setTimeout> | null = null;
    let lastRecoverMediaErrorAt = 0;
    let stuckWatchdog: ReturnType<typeof window.setInterval> | null = null;
    sessionRef.current = {
      fragmentLoads: 0,
      videoBuffers: 0,
      audioBuffers: 0,
      manifestParsed: false,
      uniqueFragUrls: new Set<string>(),
      maxVideoTime: 0,
      videoTimeOrigin: null,
      sawStaleFrag: false,
      sawBufferStall: false,
      hlsErrors: 0,
      hlsFatalErrors: 0,
      hlsBufferStalls: 0,
      ttffMs: 0,
      liveStartedAtMs: Date.now(),
      bufferSec: 0,
      playerLatencyMs: 0,
    };
    setElapsedSec(0);
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
      const relTime = sessionRelativeVideoTime(video);
      sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, relTime);
      setElapsedSec(sessionRef.current.maxVideoTime);
      const { videoWidth, videoHeight } = video;
      pushDiag(
        `video_${source} time=${relTime.toFixed(2)} (raw=${video.currentTime.toFixed(2)}) ready=${video.readyState} size=${videoWidth}x${videoHeight}`,
      );
      if (relTime > 0.25) {
        pushDiag("video_playback=ok");
      }
    }

    function attemptPlay() {
      if (destroyed) {
        return;
      }
      void video.play().catch((err: unknown) => {
        if (destroyed) {
          return;
        }
        // hls.js reattaching media / swapping the source right after
        // MANIFEST_PARSED routinely aborts an in-flight play() call — that's
        // a benign race, not a real browser autoplay policy block (the video
        // element is already muted, so NotAllowedError shouldn't happen at
        // all here). Retry briefly instead of permanently failing a stream
        // that's actually still buffering and playing fine underneath.
        const name = err instanceof DOMException ? err.name : "";
        if (name === "AbortError") {
          pushDiag("play_aborted=retrying");
          if (playRetryTimer == null) {
            playRetryTimer = window.setTimeout(() => {
              playRetryTimer = null;
              attemptPlay();
            }, 300);
          }
          return;
        }
        fail(`Autoplay blocked (${name || "play() rejected"}). Press play on the video controls.`);
      });
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
      // LL-HLS (MediaMTX, PDT + parts): let hls.js's own low-latency engine
      // manage the live edge. Overriding liveSyncDurationCount there pinned
      // playback a fixed segment count behind and *disabled* part-level sync:
      // measured live 2026-07-21, the player idled 5-6s behind MediaMTX with
      // zero catch-up pressure (liveMaxLatency was 10s), turning a ~4s chain
      // into ~10s glass-to-glass. LL-HLS defaults sync to ~3 part durations
      // and engage catch-up rate automatically.
      const llHlsTuning = {
        maxLiveSyncPlaybackRate: 1.5,
        maxBufferLength: 12,
        maxMaxBufferLength: 30,
      };
      // Zixi Fast HLS (no parts, 2s chunks, often 1-deep): keep explicit
      // segment-count sync — LL defaults assume part signaling that Zixi
      // never provides.
      const zixiTuning = {
        liveSyncDurationCount: syncCount,
        liveMaxLatencyDurationCount: shallow
          ? Math.max(syncCount + 2, 3)
          : Math.max(syncCount + 3, syncCount * 2),
        // Speed-up catch-up on a shallow window just empties the only segment.
        maxLiveSyncPlaybackRate: shallow ? 1.0 : 1.5,
        // Hold enough media for 2-segment operation; more when shallow.
        maxBufferLength: shallow ? 30 : Math.max(20, syncSec * 3),
        maxMaxBufferLength: shallow ? 60 : 40,
      };
      const hls = new Hls({
        enableWorker: true,
        // MediaMTX Apple LL-HLS needs lowLatencyMode; Zixi Fast HLS does not.
        lowLatencyMode,
        ...(lowLatencyMode ? llHlsTuning : zixiTuning),
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
        lowLatencyMode
          ? `hls_live_sync=ll-defaults targetduration=${targetDuration}s depth=${depth}`
          : `hls_live_sync=${syncCount}seg (~${syncSec.toFixed(1)}s) targetduration=${targetDuration}s depth=${depth} shallow=${shallow ? 1 : 0} ll_mode=off`,
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
        attemptPlay();
      });

      // When Zixi finally rolls past a stale edge, jump to live instead of
      // draining a multi-second backlog. On 1-deep playlists, jump less often —
      // seeking to the only segment mid-decode causes visible stutters.
      //
      // Deliberately NO video.readyState guard here: a playhead starved
      // inside a buffered-timeline hole reports readyState < 2, which is
      // exactly the state this jump exists to escape. The old readyState<2
      // guard disabled the rescue precisely when it was needed — confirmed
      // live 2026-07-21: MediaMTX LL-HLS playback froze at t=0.70s for an
      // entire run while 232 fragments appended fine past a hole.
      hls.on(Hls.Events.LEVEL_UPDATED, () => {
        if (destroyed) {
          return;
        }
        const liveSync = hls.liveSyncPosition;
        if (liveSync == null || !Number.isFinite(liveSync) || video.currentTime <= 0) {
          return;
        }
        const behind = liveSync - video.currentTime;
        const jumpThreshold = shallow ? LIVE_JUMP_BEHIND_SHALLOW_SEC : LIVE_JUMP_BEHIND_SEC;
        if (behind >= jumpThreshold) {
          // Clamp the jump into buffered media: a seek to an unbuffered
          // liveSyncPosition never completes (video.seeking sticks) and
          // freezes the playhead harder than the backlog it was escaping.
          let jumpTo = -1;
          for (let i = 0; i < video.buffered.length; i += 1) {
            const end = video.buffered.end(i);
            if (end > jumpTo) {
              jumpTo = end;
            }
          }
          jumpTo = jumpTo > 0 ? Math.min(liveSync, jumpTo - 0.5) : liveSync;
          if (jumpTo > video.currentTime + 1) {
            video.currentTime = jumpTo;
            pushDiag(
              `hls_live_jump behind=${behind.toFixed(2)}s to=${jumpTo.toFixed(2)} live_sync=${liveSync.toFixed(2)}`,
            );
          }
        }
      });

      // Stuck-playhead watchdog: a discontinuity in the appended timeline (a
      // "hole" — e.g. MediaMTX LL-HLS gap filler, or a PTS jump after a
      // webcam-bridge restart) leaves currentTime frozen while fragments keep
      // buffering *past* the hole.
      //
      // Hard-won rules (each disabled a previous incarnation of this rescue):
      //  - Do NOT pause/skip the check while video.seeking or video.paused —
      //    a seek pending into UNBUFFERED space keeps seeking=true forever,
      //    which suppressed this watchdog for 37s straight on the live site
      //    (2026-07-21 run 2: playhead pinned at vt=10.35 from t+24 to t+61).
      //  - Only ever seek to a *buffered* position. Seeking to a raw
      //    liveSyncPosition that isn't buffered just creates the pending-seek
      //    trap above all over again.
      //  - If two rescues at the same position change nothing, the decoder
      //    itself is wedged (data present, no frames) — recoverMediaError.
      let stuckSinceMs = 0;
      let lastWatchdogTime = -1;
      let rescuesAtSamePosition = 0;
      stuckWatchdog = window.setInterval(() => {
        if (destroyed) {
          return;
        }
        const now = video.currentTime;
        if (now <= 0) {
          return;
        }
        if (Math.abs(now - lastWatchdogTime) > 0.05) {
          lastWatchdogTime = now;
          stuckSinceMs = 0;
          rescuesAtSamePosition = 0;
          return;
        }
        stuckSinceMs += STUCK_WATCHDOG_POLL_MS;
        if (stuckSinceMs < STUCK_PLAYHEAD_RESCUE_MS) {
          return;
        }
        stuckSinceMs = 0;

        if (video.paused) {
          pushDiag(`stuck_paused_at=${now.toFixed(2)} play_retry`);
          attemptPlay();
          return;
        }

        // Pick the most live-ward buffered range with usable room and land
        // safely inside it (never at/past its end, never in a gap).
        let bestStart = -1;
        let bestEnd = -1;
        for (let i = 0; i < video.buffered.length; i += 1) {
          const start = video.buffered.start(i);
          const end = video.buffered.end(i);
          if (end > now + 0.3 && end > bestEnd) {
            bestStart = start;
            bestEnd = end;
          }
        }
        if (bestEnd < 0) {
          pushDiag(`stuck_no_buffered_escape at=${now.toFixed(2)} ranges=${video.buffered.length}`);
          return;
        }
        const liveSync = hls.liveSyncPosition;
        let target = bestEnd - 0.5;
        if (
          liveSync != null &&
          Number.isFinite(liveSync) &&
          liveSync >= bestStart &&
          liveSync <= bestEnd - 0.3
        ) {
          target = liveSync;
        }
        target = Math.max(target, Math.min(bestStart + 0.1, bestEnd - 0.1));

        if (target <= now + 0.2) {
          // Data exists right at the playhead but nothing renders — decoder
          // wedge, not a hole. Give the media pipeline a kick.
          rescuesAtSamePosition += 1;
          if (rescuesAtSamePosition >= 2) {
            rescuesAtSamePosition = 0;
            pushDiag(`stuck_decoder_recover at=${now.toFixed(2)}`);
            try {
              hls.recoverMediaError();
            } catch {
              /* ignore */
            }
            attemptPlay();
          } else {
            pushDiag(`stuck_nudge at=${now.toFixed(2)}`);
            video.currentTime = now + 0.1;
            attemptPlay();
          }
          return;
        }

        pushDiag(
          `stuck_rescue frozen_at=${now.toFixed(2)} jump_to=${target.toFixed(2)} buffered=[${bestStart.toFixed(2)},${bestEnd.toFixed(2)}] live_sync=${liveSync == null ? "-" : liveSync.toFixed(2)}`,
        );
        video.currentTime = target;
        attemptPlay();
      }, STUCK_WATCHDOG_POLL_MS);

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
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            sessionRef.current.sawBufferStall = true;
            sessionRef.current.hlsBufferStalls += 1;
          }
          // MediaMTX LL-HLS fills its early live window with #EXT-X-GAP
          // filler segments — buffering across them can retrigger
          // BUFFER_STALLED_ERROR immediately after recovery, and with no
          // cooldown that becomes a tight loop firing thousands of times a
          // second (seen live: 75k+ "errors" in a 15s job) while playback
          // was actually fine. recoverMediaError() itself needs time to take
          // effect — retrying it faster than that just thrashes.
          const now = Date.now();
          if (now - lastRecoverMediaErrorAt >= 2000) {
            lastRecoverMediaErrorAt = now;
            pushDiag("media_error_recoverable=trying");
            hls.recoverMediaError();
          }
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
        const relTime = sessionRelativeVideoTime(video);
        sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, relTime);
        setElapsedSec(sessionRef.current.maxVideoTime);
        sessionRef.current.bufferSec = bufferedAheadSec(video);
        // PDT-based glass latency (finite only when the playlist carries
        // PROGRAM-DATE-TIME, e.g. MediaMTX LL-HLS).
        const pdtLatency = hls.latency;
        if (Number.isFinite(pdtLatency) && pdtLatency > 0) {
          sessionRef.current.playerLatencyMs = Math.round(pdtLatency * 1000);
        }
        if (sessionRef.current.ttffMs <= 0 && relTime > 0.25) {
          sessionRef.current.ttffMs = Math.max(
            0,
            Date.now() - sessionRef.current.liveStartedAtMs,
          );
          pushDiag(`ttff_ms=${sessionRef.current.ttffMs}`);
        }
      });
      video.addEventListener("play", () => setIsPlaying(true));
      video.addEventListener("pause", () => setIsPlaying(false));
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
      if (playRetryTimer != null) {
        window.clearTimeout(playRetryTimer);
        playRetryTimer = null;
      }
      if (stuckWatchdog != null) {
        window.clearInterval(stuckWatchdog);
        stuckWatchdog = null;
      }
      hlsInstance?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, playbackGate, jobStatus]);

  const gateMessage =
    playbackGate !== "live" ? playbackGateLabel(playbackGate, "hls") : null;

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }

  function formatElapsed(totalSec: number): string {
    const safe = Math.max(0, Math.floor(totalSec));
    const mm = Math.floor(safe / 60);
    const ss = safe % 60;
    return `${mm}:${ss.toString().padStart(2, "0")}`;
  }

  return (
    <div className="player-surface">
      {/*
        No native `controls` here on purpose. Managed Zixi SRT streams shift
        video.currentTime by a monotonic Fast-HLS republish offset (see
        zixi_ts_offset.py), so the browser's own seek bar would show an
        absolute, ever-growing stream-lifetime position instead of "seconds
        into this run" — that is what previously looked like "hours of
        media" while barely anything played. The elapsed readout below is
        rebased to this session instead.
      */}
      <video ref={videoRef} className="player-video" playsInline muted autoPlay />
      <div className="player-controls">
        <button
          type="button"
          className="ghost-button"
          disabled={playbackGate !== "live"}
          onClick={togglePlayPause}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button type="button" className="ghost-button" onClick={toggleMute}>
          {isMuted ? "Unmute" : "Mute"}
        </button>
        {playbackGate === "live" && (
          <span className="hint player-elapsed">Elapsed {formatElapsed(elapsedSec)}</span>
        )}
      </div>
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
        encodeLadder={encodeLadder}
        targetLatencyMs={targetLatencyMs}
        zixiStreamId={zixiStreamId}
      />
    </div>
  );
}
