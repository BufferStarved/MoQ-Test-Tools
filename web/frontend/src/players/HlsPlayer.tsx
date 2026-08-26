import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { resolvePlaybackXhrUrl } from "../playbackFetch";
import { waitingPlayerStatus, type PlaybackGate } from "../playbackGate";
import { isGracefulHlsEos } from "../hlsEos";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
import { clockSkewMs } from "../clockSkew";
import { createPlaybackDiagReporter } from "../playbackDiag";
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
import { PlayerDiagnostics } from "./PlayerDiagnostics";
import { GoLiveButton } from "../GoLiveButton";
import { formatGoLiveDiag, goLiveHoldSec, latchGoLive, seekGoLive } from "../goLive";
import { usablePackagerTransitMs } from "../glassLatency";
import { elapsedSecFromStart } from "../playbackMetrics";
import {
  hlsLiveSyncDurationCount,
  hlsSyncDurationForPlaylist,
  isStaleHlsFragmentLoop,
  playlistDepth,
  playlistTargetDurationSec,
} from "../hlsPlaylist";

interface HlsPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  waitingForEncodeSlot?: boolean;
  encodeQueueAhead?: number;
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
  /** Capture->bridge-output lag (ms) for live webcam runs; 0 for VOD. */
  bridgeLagMs?: number;
  /** This leg's encoder lag behind realtime (ms). */
  encoderLagMs?: number;
  /** LL-HLS: server-measured encoder→packager transit (ms). PDT is stamped at
   * PACKAGING time, so PDT-based latency alone misses SRT tsbpd + network +
   * remux upstream of the packager (~2.7s measured 2026-08-09). */
  packagerTransitMs?: number | null;
  /** Zixi Fast HLS: encode-media seconds corresponding to buffer time 0. */
  deliveryMediaOriginSec?: number | null;
  /** Zixi SRT/RTMP: switch the card to MPEG-TS when Fast HLS cannot recover. */
  onUnrecoverableHls?: () => void;
  playbackPolicy?: "live-edge" | "complete";
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
/** Faster give-up when MPEG-TS fallback is available (~3s vs ~24s). */
const MANIFEST_STUCK_POLLS_FALLBACK = 8;
/** Only jump when clearly stuck behind; aggressive jumps on 1-deep playlists stutter. */
const LIVE_JUMP_BEHIND_SEC = 4;
const LIVE_JUMP_BEHIND_SHALLOW_SEC = 6;
/** LL-HLS parts are 200ms; 4s was a whole regular-HLS window behind live. */
const LIVE_JUMP_BEHIND_LL_SEC = 2;
/**
 * Playhead frozen this long while data keeps buffering => escape the hole.
 * 2500ms (was 4000): the rescue ladder (nudge -> decoder recover -> full
 * restart) needs up to three rounds, and at 4s per round a wedge cost a
 * 12s visible freeze (webcam run 2026-08-08 23:45, SRT leg frozen 28-40s).
 * 2.5s keeps it clear of routine sub-second rebuffers while cutting the
 * worst-case ladder to ~7.5s.
 */
const STUCK_PLAYHEAD_RESCUE_MS = 2500;
const STUCK_WATCHDOG_POLL_MS = 500;

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
  stuckPolls: number = MANIFEST_STUCK_POLLS,
): Promise<string | null> {
  const manifestUrl = proxiedPlaybackUrl(url);
  let previousSequence: string | null = null;
  let previousSegment: string | null = null;
  let unchangedPolls = 0;
  let unreadablePolls = 0;
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

        // Zixi can advance MEDIA-SEQUENCE while every chunk stays HTTP 400.
        // That resets unchangedPolls and used to burn the full 48s poll budget
        // before MPEG-TS fallback. Count unreadable segments separately.
        if (candidate && segment && !segmentReady) {
          unreadablePolls += 1;
          if (unreadablePolls >= stuckPolls) {
            onStuck?.(sequence ?? "unknown");
            return null;
          }
        } else if (segmentReady) {
          unreadablePolls = 0;
        }

        if (
          (sequence && previousSequence && sequence === previousSequence) ||
          (segment && previousSegment && segment === previousSegment)
        ) {
          unchangedPolls += 1;
          if (unchangedPolls >= stuckPolls) {
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
  waitingForEncodeSlot = false,
  encodeQueueAhead = 0,
  benchmarkLoading = false,
  liveSyncDurationCount = 2,
  liveSyncDurationSec,
  encodeLadder,
  targetLatencyMs,
  zixiStreamId,
  lowLatencyMode = false,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  packagerTransitMs = null,
  deliveryMediaOriginSec = null,
  onUnrecoverableHls,
  playbackPolicy = "live-edge",
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for encode...");
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const lastErrorRef = useRef<string | null>(null);
  const goLiveRef = useRef({ atSec: 0, e2eMs: 0 });
  const hlsLiveRef = useRef<{ liveSyncPosition: number | null } | null>(null);
  const hlsTargetDurationRef = useRef(2);
  const onUnrecoverableHlsRef = useRef(onUnrecoverableHls);
  onUnrecoverableHlsRef.current = onUnrecoverableHls;
  const sessionRef = useRef({
    fragmentLoads: 0,
    fragmentLoadsAtRestart: 0,
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
    // PROGRAM-DATE-TIME (epoch ms) of the current playhead, from
    // hls.playingDate. MediaMTX LL-HLS carries PDT; Zixi Fast HLS does not
    // (stays 0). Stored as the PDT itself — NOT a precomputed latency — so
    // the e2e snapshot (now − PDT) keeps growing while the playhead is
    // frozen. The old `hls.latency` snapshot only updated on timeupdate,
    // which froze the reported latency at ~4.1s through a 12s stall
    // (webcam run 2026-08-08 23:45, SRT leg) and made the stalled leg look
    // faster than the healthy ones.
    playheadPdtMs: 0,
    // Raw video.currentTime (un-rebased) — used with fragTimelineOffsetSec.
    rawVideoTime: 0,
    // Zixi Fast HLS: hls.js maps buffer time 0 to the start of the playlist
    // window AT JOIN, not to media 0 — a mid-stream join reads several
    // seconds behind the true encoder-timeline position (3.8s vs a burnt-in
    // timer, 2026-08-09) and overstates wall−playhead latency by exactly
    // that. Zixi cuts uniform-duration chunks numbered from 0 per input
    // session, so frag.sn × duration − frag.start recovers the offset from
    // buffer timeline to encoder media timeline.
    fragTimelineOffsetSec: null as number | null,
    wallOriginCalibrated: false,
    bitrateBps: 0,
    // Startup milestones (epoch ms), for the player-chain decomposition. Both
    // are event instants rather than derived durations: first_paint is timed
    // from the frame that actually appeared, not by subtracting the earlier
    // phases out of ttff, so the chain can disagree with ttff and say so.
    firstMediaAtMs: 0,
    firstPaintAtMs: 0,
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
  // rebasing stays on there — its true latency comes from the playhead's
  // PROGRAM-DATE-TIME instead (see playheadPdtMs).
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
  const startupPhasesRef = useRef<StartupPlayerPhases>({ ...EMPTY_STARTUP_PHASES });

  /**
   * Player-chain startup phases (see src/startup_budget.py).
   *
   * The manifest request is the only one of the four boundaries the player does
   * not observe directly, so it comes from Resource Timing on the playlist URL:
   * `fetchStart → requestStart` is DNS + connect + TLS, `requestStart →
   * responseEnd` is the playlist itself. Playback normally goes through the
   * app's own `/api/playback/fetch` proxy, which makes those entries
   * same-origin and fully visible; a direct playlist URL on a packager host is
   * cross-origin and its interior marks are zeroed unless the packager sends
   * `Timing-Allow-Origin`, in which case both phases report unmeasured rather
   * than a 0 ms connect (see startupTiming.isOpaqueResourceTiming).
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

  // Live upstream lag components (props change every sample poll); refs keep
  // the memoized snapshot getter reading fresh values.
  const lagRef = useRef({
    bridgeMs: 0,
    encoderMs: 0,
    epoch: 0,
    lowLatency: false,
    transitMs: null as number | null,
    deliveryOriginSec: null as number | null,
    liveSyncSec: 4,
  });
  lagRef.current = {
    bridgeMs: bridgeLagMs,
    encoderMs: encoderLagMs,
    epoch: encodeStartedAtEpoch ?? 0,
    lowLatency: lowLatencyMode,
    transitMs: packagerTransitMs,
    deliveryOriginSec: deliveryMediaOriginSec,
    liveSyncSec: liveSyncDurationSec ?? 4,
  };

  /**
   * Capture-anchored glass-to-glass estimate (ms). All protocols share the
   * same anchor: the capture instant of the displayed frame.
   *  - LL-HLS (MediaMTX): PDT latency covers packager->glass; add the
   *    browser->bridge chain.
   *  - Zixi Fast HLS: the timeline is encode-anchored, so wall - position
   *    covers encoder->glass; add only the bridge chain.
   * encode_lag_ms is deliberately NOT added: it is a baseline-subtracted
   * "encoder falling behind" gauge, not a latency component — the old code
   * summed the raw startup offset (~1.2-2.4s of one-time warmup) into every
   * per-second e2e sample.
   * Validated against a burnt-in wall-clock timer (2026-07-21/22) after each
   * estimate individually read 2.5-4s low/high with mismatched anchors.
   */
  function captureAnchoredE2eMs(): number | undefined {
    const { bridgeMs, epoch, lowLatency, transitMs, deliveryOriginSec } = lagRef.current;
    const session = sessionRef.current;
    if (lowLatency) {
      if (session.playheadPdtMs > 0) {
        // PDT is stamped by the (NTP-synced) packager VM *at packaging time*;
        // (now − PDT) covers packager→glass only. packagerTransitMs is the
        // server-measured encoder→packager leg (SRT tsbpd + network + remux);
        // without it LL-HLS understated e2e by ~2.7s vs a burnt-in timer
        // (2026-08-09). Adding it is correct once — a stale (elapsed−1s)
        // snapshot must not stick on every later sample.
        const transit = usablePackagerTransitMs({
          transitMs,
          playheadPdtMs: session.playheadPdtMs,
          epochSec: epoch,
        });
        const total =
          Date.now() + clockSkewMs() - session.playheadPdtMs + transit + bridgeMs;
        return total > 0 && total < 120_000 ? Math.round(total) : undefined;
      }
      return undefined;
    }
    if (epoch > 0 && session.maxVideoTime > 0) {
      // Prefer server-published delivery origin (Zixi 1-deep playlists keep
      // MEDIA-SEQUENCE at 0, so frag.sn mapping cannot recover the join
      // offset — truth run 2026-08-10: raw currentTime lagged glass by
      // ~3.7s and overstated e2e by the same amount). Fall back to
      // fragment chunk= mapping, then a one-shot wall-clock calibration
      // against the configured live-sync delay, then session-relative time.
      let mediaPosSec = session.maxVideoTime;
      if (deliveryOriginSec != null && session.videoTimeOrigin === 0) {
        mediaPosSec = session.rawVideoTime + deliveryOriginSec;
      } else if (session.fragTimelineOffsetSec != null && session.videoTimeOrigin === 0) {
        mediaPosSec = session.rawVideoTime + session.fragTimelineOffsetSec;
      } else if (
        session.videoTimeOrigin === 0 &&
        session.rawVideoTime > 1 &&
        !session.wallOriginCalibrated
      ) {
        const { liveSyncSec } = lagRef.current;
        const estMedia =
          (Date.now() + clockSkewMs()) / 1000 - epoch - Math.max(2, liveSyncSec);
        session.fragTimelineOffsetSec = estMedia - session.rawVideoTime;
        session.wallOriginCalibrated = true;
        mediaPosSec = session.rawVideoTime + session.fragTimelineOffsetSec;
      }
      const total = Date.now() + clockSkewMs() - epoch * 1000 - mediaPosSec * 1000 + bridgeMs;
      return total > 0 && total < 120_000 ? Math.round(total) : undefined;
    }
    return undefined;
  }

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => {
      const frames = readVideoFrameStats(videoRef.current);
      persistJobRebuffer(jobId, rebufferRef.current);
      return {
        playback_stats_events: frames.framesRendered > 0 ? 1 : 0,
        // HTML wait brackets (same definition as MoQ / MPEG-TS / DASH / WHEP).
        playback_stall_count: rebufferRef.current.stallCount,
        playback_frames_rendered: frames.framesRendered,
        playback_frames_dropped: frames.framesDropped,
        playback_bitrate_bps: sessionRef.current.bitrateBps || 0,
        playback_ttff_ms: sessionRef.current.ttffMs,
        playback_hls_errors: sessionRef.current.hlsErrors,
        playback_hls_fatal_errors: sessionRef.current.hlsFatalErrors,
        playback_hls_buffer_stalls: sessionRef.current.hlsBufferStalls,
        playback_hls_frag_loads: sessionRef.current.fragmentLoads,
        playback_video_time_sec: sessionRef.current.maxVideoTime,
        playback_buffer_sec: sessionRef.current.bufferSec,
        playback_rebuffer_sec: rebufferRef.current.totalSec,
        e2e_latency_ms: captureAnchoredE2eMs(),
        go_live_at_sec: goLiveRef.current.atSec,
        go_live_e2e_ms: goLiveRef.current.e2eMs,
        ...startupPhases(),
      };
    },
    [jobId],
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
            ? waitingPlayerStatus({
                engine: "hls",
                jobStatus,
                waitingForEncodeSlot,
                encodeQueueAhead,
              })
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
      fragmentLoadsAtRestart: 0,
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
      playheadPdtMs: 0,
      rawVideoTime: 0,
      fragTimelineOffsetSec: null,
      wallOriginCalibrated: false,
      bitrateBps: 0,
      firstMediaAtMs: 0,
      firstPaintAtMs: 0,
    };
    startupPhasesRef.current = { ...EMPTY_STARTUP_PHASES };
    setElapsedSec(0);
    rebufferRef.current.reset();
    loadJobRebuffer(jobId, rebufferRef.current);
    // Attach BEFORE async manifest/hls setup — otherwise join-time stalls after
    // first frame are invisible to metrics (truth harness Δ1s+ on RTMP/SRT).
    const detachHtmlMonitors = attachHtmlPlaybackMonitors(video, {
      rebuffer: rebufferRef.current,
      hasPlayedOnce: () => sessionRef.current.ttffMs > 0,
      onStallBegin: () => {
        persistJobRebuffer(jobId, rebufferRef.current);
      },
    });

    const diagReporter = createPlaybackDiagReporter(jobId, lowLatencyMode ? "ll-hls" : "hls");

    function pushDiag(line: string) {
      if (!destroyed) {
        setDiagLines((current) => [...current.slice(-12), line]);
        diagReporter.push(line);
      }
    }

    let fallbackRequested = false;
    function requestMpegTsFallback(reason: string): boolean {
      const fallback = onUnrecoverableHlsRef.current;
      if (fallbackRequested || !fallback) {
        return false;
      }
      fallbackRequested = true;
      pushDiag(`hls_fallback_mpegts reason=${reason}`);
      fallback();
      return true;
    }

    function fail(message: string, allowFallback = false) {
      lastErrorRef.current = message;
      if (allowFallback && requestMpegTsFallback(message)) {
        setStatus("Switching to MPEG-TS…");
        return;
      }
      setError(message);
      setStatus("Failed");
      diagReporter.push(`FAIL ${message}`);
    }

    function noteVideoProgress(source: string) {
      const relTime = sessionRelativeVideoTime(video);
      sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, relTime);
      sessionRef.current.rawVideoTime = video.currentTime;
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
              Boolean(onUnrecoverableHlsRef.current),
            );
          }
        },
        onUnrecoverableHlsRef.current ? MANIFEST_STUCK_POLLS_FALLBACK : MANIFEST_STUCK_POLLS,
      );

      if (destroyed) {
        return;
      }
      if (!manifestBody) {
        fail(
          "HLS never became playable during the encode (playlist appeared but segments stayed HTTP 400). Zixi needs a few seconds after the first SRT packets before chunk N is readable — check diagnostics for segment_ready=yes.",
          Boolean(onUnrecoverableHlsRef.current),
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
      hlsTargetDurationRef.current = targetDuration;
      // LL-HLS (MediaMTX, PDT + parts): let hls.js's own low-latency engine
      // manage the live edge. Overriding liveSyncDurationCount there pinned
      // playback a fixed segment count behind and *disabled* part-level sync:
      // measured live 2026-07-21, the player idled 5-6s behind MediaMTX with
      // zero catch-up pressure (liveMaxLatency was 10s), turning a ~4s chain
      // into ~10s glass-to-glass. LL-HLS defaults sync to ~3 part durations
      // and engage catch-up rate automatically.
      const llHlsTuning = {
        // MediaMTX advertises 200ms parts, so the LL-HLS default latency
        // target (PART-HOLD-BACK ≈ 3 parts) is only ~0.6s. Through the
        // /api/playback/fetch proxy that cushion drains on routine jitter.
        // 3.0s (2026-08-08 webcam cushion) plus a frozen 4.6s packager
        // snapshot stacked a ~10s SRT glass delay (comparison 2026-08-23).
        // 1.5s keeps a proxy cushion without pinning three full seconds
        // behind live. Duration (seconds) — NOT liveSyncDurationCount,
        // which is what disabled part sync in the 2026-07-21 regression.
        liveSyncDuration: playbackPolicy === "complete" ? 3 : 1.5,
        // 1.5× chasing visibly warbled: rate ramps toward the cap whenever
        // latency drifts >50ms past the tight target, then snaps back to 1.0.
        // 1.15× is still imperceptible and recovers ~0.75s of drift per ~5s.
        maxLiveSyncPlaybackRate: playbackPolicy === "complete" ? 1.0 : 1.15,
        // MediaMTX fMP4 part boundaries can leave sub-500ms A/V gaps; skip
        // them via the gap controller instead of stalling (default is 0.1s).
        maxBufferHole: 0.5,
        maxBufferLength: 8,
        maxMaxBufferLength: 16,
      };
      // Zixi Fast HLS (no parts, 2s chunks, often 1-deep): keep explicit
      // segment-count sync — LL defaults assume part signaling that Zixi
      // never provides.
      const zixiTuning = {
        // A 1-deep Fast HLS playlist only has one segment. Asking hls.js for
        // two (the default liveSyncDurationCount) waits for media that never
        // arrives and freezes after the first GOP (rendered stuck ~35).
        liveSyncDurationCount: hlsLiveSyncDurationCount(depth, syncCount),
        liveMaxLatencyDurationCount: shallow
          ? Math.max(syncCount + 2, 3)
          : Math.max(syncCount + 3, syncCount * 2),
        // Speed-up catch-up on a shallow window just empties the only segment.
        // 1.5× read as visible warble on deep windows too — 1.1× recovers
        // drift without perceptible speed changes (smoothness > latency).
        maxLiveSyncPlaybackRate: playbackPolicy === "complete" || shallow ? 1.0 : 1.1,
        // Hold enough media for 2-segment operation; more when shallow.
        maxBufferLength: shallow ? 30 : Math.max(20, syncSec * 3),
        maxMaxBufferLength: shallow ? 60 : 40,
      };
      const hlsConfig = {
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
        xhrSetup(xhr: XMLHttpRequest, requestUrl: string) {
          const resolved = resolvePlaybackXhrUrl(requestUrl);
          lastRequestUrl = resolved;
          xhr.open("GET", resolved);
        },
      };
      pushDiag(
        lowLatencyMode
          ? `hls_live_sync=ll target=1.5s max_rate=1.15 targetduration=${targetDuration}s depth=${depth}`
          : `hls_live_sync=${syncCount}seg (~${syncSec.toFixed(1)}s) targetduration=${targetDuration}s depth=${depth} shallow=${shallow ? 1 : 0} ll_mode=off`,
      );

      let hls: InstanceType<typeof Hls>;

      // Full-teardown escape hatch: when gentler recovery (seek, startLoad,
      // recoverMediaError) can't unwedge the pipeline, rebuild the whole Hls
      // instance from scratch. Bounded so a genuinely dead upstream can't
      // loop restarts forever — after the budget we surface a hard failure
      // instead of sitting silently wedged. The budget REPLENISHES after
      // sustained healthy playback (see the stuck watchdog): on a 300s run,
      // early-join hiccups used to eat the whole budget and leave the tail
      // frozen with no recovery allowed (webcam run 2026-08-08: SRT playhead
      // pinned for the final 30s with ~2s still buffered).
      const MAX_HLS_RESTARTS = 3;
      let hlsRestarts = 0;
      const RECOVER_MEDIA_ERROR_COOLDOWN_MS = 2000;
      const MAX_MEDIA_ERROR_RECOVERIES = 3;
      let mediaErrorRecoveries = 0;
      // Continuous forward playback (ms) that proves the pipeline healthy
      // again and resets the recovery budgets.
      const RECOVERY_BUDGET_RESET_AFTER_MS = 30_000;
      let healthySinceMs = 0;

      function restartHls(reason: string): boolean {
        if (destroyed) {
          return false;
        }
        if (hlsRestarts >= MAX_HLS_RESTARTS) {
          pushDiag(`hls_restart_budget_exhausted reason=${reason}`);
          // First GOP (~2s / ~35 frames) is not "playback OK" on a 1-deep
          // Fast HLS pack — that is the freeze we fall back to MPEG-TS for.
          const paintedOnlyFirstGop = sessionRef.current.maxVideoTime > 0 && sessionRef.current.maxVideoTime < 4;
          fail(
            `HLS playback wedged and ${MAX_HLS_RESTARTS} full player restarts did not recover it (${reason}).`,
            Boolean(onUnrecoverableHlsRef.current) &&
              (shallow || paintedOnlyFirstGop || !hlsPlaybackOk(sessionRef.current)),
          );
          return false;
        }
        hlsRestarts += 1;
        mediaErrorRecoveries = 0;
        sessionRef.current.uniqueFragUrls = new Set();
        sessionRef.current.fragmentLoadsAtRestart = sessionRef.current.fragmentLoads;
        pushDiag(`hls_full_restart=${hlsRestarts}/${MAX_HLS_RESTARTS} reason=${reason}`);
        try {
          hls.destroy();
        } catch {
          /* ignore */
        }
        hls = createHls();
        attemptPlay();
        return true;
      }

      /**
       * recoverMediaError() must end with media attached and fragment loading
       * running. Internally it detaches (stopLoad + fragment tracker cleared +
       * buffers destroyed) then reattaches and calls startLoad(currentTime) —
       * but a frozen currentTime can point outside the slid live window, in
       * which case loading silently never resumes (webcam run e691e691:
       * frag_loads froze at 125 for 14+s while the 4s stuck-playhead rescue
       * found no buffered escape). Verify shortly after and force the loader
       * back to the live edge if no fragment landed; escalate to a full
       * restart if even that fails.
       */
      function scheduleRecoveryResumeCheck(instance: InstanceType<typeof Hls>) {
        const fragLoadsAtRecover = sessionRef.current.fragmentLoads;
        window.setTimeout(() => {
          if (destroyed || hls !== instance) {
            return;
          }
          if (!instance.media) {
            pushDiag("recover_resume=media_still_detached reattach");
            try {
              instance.attachMedia(video);
              instance.startLoad(-1);
            } catch {
              restartHls("reattach_failed");
              return;
            }
            attemptPlay();
            return;
          }
          if (sessionRef.current.fragmentLoads === fragLoadsAtRecover) {
            pushDiag("recover_resume=frag_loading_stalled start_load_live_edge");
            try {
              instance.startLoad(-1);
            } catch {
              restartHls("start_load_failed");
              return;
            }
            attemptPlay();
          }
        }, 2500);
      }

      /** The only sanctioned path to recoverMediaError(): cooldown-limited,
       *  always paired with a resume check, escalating to a full restart once
       *  repeated recoveries stop helping. */
      function recoverMediaErrorChecked(reason: string): boolean {
        if (destroyed) {
          return false;
        }
        const now = Date.now();
        if (now - lastRecoverMediaErrorAt < RECOVER_MEDIA_ERROR_COOLDOWN_MS) {
          // A recovery (and its resume check) is already in flight.
          return true;
        }
        if (mediaErrorRecoveries >= MAX_MEDIA_ERROR_RECOVERIES) {
          return restartHls(`${reason}_recoveries_exhausted`);
        }
        mediaErrorRecoveries += 1;
        lastRecoverMediaErrorAt = now;
        pushDiag(
          `media_error_recover=${mediaErrorRecoveries}/${MAX_MEDIA_ERROR_RECOVERIES} reason=${reason}`,
        );
        try {
          hls.recoverMediaError();
        } catch {
          return restartHls(`${reason}_recover_threw`);
        }
        scheduleRecoveryResumeCheck(hls);
        return true;
      }

      /** Builds a fully wired Hls instance. Everything the instance needs is
       *  (re)bound here so a full restart never leaves a handler pointing at
       *  a destroyed instance. */
      function createHls(): InstanceType<typeof Hls> {
        const instance = new Hls(hlsConfig);
        hlsInstance = instance;
        hlsLiveRef.current = instance;
        instance.loadSource(manifestUrl);
        instance.attachMedia(video);

        instance.on(Hls.Events.MANIFEST_PARSED, () => {
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
        instance.on(Hls.Events.LEVEL_UPDATED, () => {
          if (destroyed) {
            return;
          }
          const liveSync = instance.liveSyncPosition;
          if (liveSync == null || !Number.isFinite(liveSync) || video.currentTime <= 0) {
            return;
          }
          const behind = liveSync - video.currentTime;
          const jumpThreshold = lowLatencyMode
            ? LIVE_JUMP_BEHIND_LL_SEC
            : shallow
              ? LIVE_JUMP_BEHIND_SHALLOW_SEC
              : LIVE_JUMP_BEHIND_SEC;
          if (playbackPolicy !== "complete" && behind >= jumpThreshold) {
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

        instance.on(Hls.Events.FRAG_LOADED, () => {
          sessionRef.current.fragmentLoads += 1;
          if (sessionRef.current.firstMediaAtMs <= 0) {
            // First media response completed. Everything between the playlist
            // arriving and this instant is the packager: on the 23s RTMP join
            // the playlist was served immediately and no decodable chunk
            // existed yet, which is exactly the span this milestone closes.
            sessionRef.current.firstMediaAtMs = Date.now();
          }
          const level = instance.levels?.[instance.currentLevel];
          const estimate = instance.bandwidthEstimate;
          sessionRef.current.bitrateBps = Math.round(
            level?.bitrate || (Number.isFinite(estimate) ? estimate : 0) || 0,
          );
          sessionRef.current.uniqueFragUrls.add(lastRequestUrl);
          const uniqueCount = sessionRef.current.uniqueFragUrls.size;
          const sameUrlLoads =
            sessionRef.current.fragmentLoads - sessionRef.current.fragmentLoadsAtRestart;
          // 1-deep Zixi playlists reload the current chunk until the next IDR.
          // That is healthy — only treat as stale when video never advanced.
          const isStale = isStaleHlsFragmentLoop({
            uniqueUrlCount: uniqueCount,
            sameUrlLoads,
            videoAdvanced: sessionRef.current.maxVideoTime > 0.25,
            playheadFrozen:
              sessionRef.current.maxVideoTime > 0.25 &&
              Math.abs(video.currentTime - sessionRef.current.maxVideoTime) < 0.2,
          });
          sessionRef.current.sawStaleFrag = isStale;
          const stale = isStale ? " stale=yes" : "";
          pushDiag(
            `frag_loaded=${sessionRef.current.fragmentLoads} unique=${uniqueCount}${stale} last=${lastRequestUrl}`,
          );
          if (isStale && !destroyed) {
            if (restartHls("stale_fragment_loop")) {
              return;
            }
            fail(
              "Zixi HLS is looping a single stale segment (playlist not advancing). " +
                "The web host needs ZIXI_API_BASE/ZIXI_API_PASSWORD so each SRT push can reset the input.",
              Boolean(onUnrecoverableHlsRef.current),
            );
            instance.destroy();
          }
        });

        // Buffer-timeline → encoder-media-timeline offset for Zixi Fast HLS.
        // Playlists keep EXT-X-MEDIA-SEQUENCE at 0 (1-deep), so frag.sn is
        // useless — but the segment URL carries chunk=N which advances each
        // rollover (verified 2026-08-10: chunk=0,2,3,… during a live run).
        instance.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
          if (destroyed || lowLatencyMode) {
            return;
          }
          const frag = data?.frag;
          if (!frag || !Number.isFinite(frag.start) || !Number.isFinite(frag.duration)) {
            return;
          }
          if (frag.duration <= 0) {
            return;
          }
          // Prefer Zixi's chunk=N (advances every rollover). Decode the URL
          // first — playback goes through /api/playback/fetch?url=... so
          // chunk= is embedded as chunk%3D. Do NOT trust frag.sn when it is
          // 0: Zixi keeps EXT-X-MEDIA-SEQUENCE at 0, and sn=0 yields offset≈0
          // which silently disables the correction (truth runs kept reporting
          // ~8s e2e vs ~4.6s glass).
          let sn: number | null = null;
          const rawUrl = frag.url || lastRequestUrl || "";
          let decodedUrl = rawUrl;
          try {
            decodedUrl = decodeURIComponent(rawUrl);
          } catch {
            /* keep raw */
          }
          const chunkMatch = /[?&]chunk=(\d+)/i.exec(decodedUrl);
          if (chunkMatch) {
            sn = Number.parseInt(chunkMatch[1], 10);
          } else if (typeof frag.sn === "number" && frag.sn > 0) {
            sn = frag.sn;
          }
          if (sn == null || !Number.isFinite(sn)) {
            return;
          }
          const offset = sn * frag.duration - frag.start;
          if (Number.isFinite(offset) && Math.abs(offset) < 600) {
            sessionRef.current.fragTimelineOffsetSec = offset;
          }
        });

        instance.on(Hls.Events.BUFFER_APPENDED, (_event, data) => {
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

        instance.on(Hls.Events.ERROR, (_event, data) => {
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
            // NON-FATAL media errors are the gap controller narrating its own
            // (usually successful) self-healing — BUFFER_STALLED_ERROR,
            // BUFFER_SEEK_OVER_HOLE, BUFFER_NUDGE_ON_STALL and friends. Never
            // answer them with recoverMediaError(): that detach/reattach
            // resumes loading at startLoad(currentTime), and a frozen
            // currentTime outside the slid live window silently kills
            // fragment loading for good (webcam run e691e691: the player
            // "recovered" a routine nudge notification into a permanent
            // wedge, frag_loads frozen at 125). Log-only; genuine wedges are
            // caught by the stuck-playhead watchdog and the fatal path below.
            return;
          }
          if (!data.fatal) {
            return;
          }

          // End-of-stream: Zixi/MediaMTX tear down the input; playlist refresh
          // 404s, fails to parse, or fatally fails level/audio loads. If we
          // already played video, treat as EOS instead of a red error.
          if (
            isGracefulHlsEos({
              details: String(data.details || ""),
              httpStatus: data.response?.code,
              playbackOk: hlsPlaybackOk(sessionRef.current),
            })
          ) {
            pushDiag("eos_graceful=playlist_gone_after_playback_ok");
            try {
              instance.stopLoad();
            } catch {
              /* ignore */
            }
            setError(null);
            lastErrorRef.current = null;
            setStatus("Playback OK");
            return;
          }

          // Fatal MEDIA_ERROR is the one case hls.js docs prescribe
          // recoverMediaError() for. Bounded + verified: falls through to a
          // hard failure only once recovery and restarts are exhausted.
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (recoverMediaErrorChecked("fatal_media_error")) {
              return;
            }
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

        return instance;
      }

      hls = createHls();

      // Stuck-playhead watchdog: a discontinuity in the appended timeline (a
      // "hole" — e.g. MediaMTX LL-HLS gap filler, or a PTS jump after a
      // webcam-bridge restart) leaves currentTime frozen while fragments keep
      // buffering *past* the hole. Lives OUTSIDE createHls so it survives
      // full restarts; it always reads the current `hls` instance.
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
      //    itself is wedged (data present, no frames) — checked media-error
      //    recovery, escalating to a bounded full restart.
      //  - No buffered escape route means fragment loading itself died (the
      //    e691e691 wedge): kick the loader to the live edge, then restart.
      let stuckSinceMs = 0;
      let lastWatchdogTime = -1;
      let rescuesAtSamePosition = 0;
      let noEscapeStrikes = 0;
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
          noEscapeStrikes = 0;
          // Sustained progress re-arms the full-restart / media-error budgets
          // so early-run hiccups don't leave a long benchmark unrecoverable.
          healthySinceMs += STUCK_WATCHDOG_POLL_MS;
          if (
            healthySinceMs >= RECOVERY_BUDGET_RESET_AFTER_MS &&
            (hlsRestarts > 0 || mediaErrorRecoveries > 0)
          ) {
            pushDiag(
              `recovery_budget_reset after=${Math.round(healthySinceMs / 1000)}s healthy (restarts=${hlsRestarts} recoveries=${mediaErrorRecoveries})`,
            );
            hlsRestarts = 0;
            mediaErrorRecoveries = 0;
          }
          return;
        }
        healthySinceMs = 0;
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
          // Playhead frozen AND nothing buffered ahead: fragment loading is
          // wedged, not just the decoder. First strike kicks the loader back
          // to the live edge; a second strike (another 4s frozen) means the
          // kick didn't take — rebuild the player.
          noEscapeStrikes += 1;
          pushDiag(
            `stuck_no_buffered_escape at=${now.toFixed(2)} ranges=${video.buffered.length} strike=${noEscapeStrikes} shallow=${shallow ? 1 : 0}`,
          );
          if (shallow && requestMpegTsFallback("shallow_playhead_frozen")) {
            return;
          }
          if (noEscapeStrikes === 1) {
            try {
              hls.startLoad(-1);
            } catch {
              restartHls("stuck_start_load_threw");
              return;
            }
            attemptPlay();
          } else {
            noEscapeStrikes = 0;
            restartHls("stuck_no_buffered_escape");
          }
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
          // wedge, not a hole. Give the media pipeline a kick; the checked
          // recovery verifies loading resumes and escalates on its own.
          rescuesAtSamePosition += 1;
          if (rescuesAtSamePosition >= 2) {
            rescuesAtSamePosition = 0;
            pushDiag(`stuck_decoder_recover at=${now.toFixed(2)}`);
            recoverMediaErrorChecked("stuck_decoder");
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

      video.addEventListener("loadeddata", () => noteVideoProgress("loadeddata"));
      video.addEventListener("playing", () => {
        noteVideoProgress("playing");
      });
      video.addEventListener("timeupdate", () => {
        if (destroyed) {
          return;
        }
        const relTime = sessionRelativeVideoTime(video);
        sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, relTime);
        sessionRef.current.rawVideoTime = video.currentTime;
        setElapsedSec(sessionRef.current.maxVideoTime);
        sessionRef.current.bufferSec = bufferedAheadSec(video);
        // Playhead PDT (finite only when the playlist carries
        // PROGRAM-DATE-TIME, e.g. MediaMTX LL-HLS). Store the PDT itself so
        // the e2e snapshot stays stall-correct (see playheadPdtMs).
        const playingDate = hls.playingDate;
        if (playingDate) {
          const pdtMs = playingDate.getTime();
          if (Number.isFinite(pdtMs) && pdtMs > 0) {
            sessionRef.current.playheadPdtMs = pdtMs;
          }
        }
        if (sessionRef.current.ttffMs <= 0 && relTime > 0.25) {
          sessionRef.current.firstPaintAtMs = Date.now();
          sessionRef.current.ttffMs = Math.max(
            0,
            sessionRef.current.firstPaintAtMs - sessionRef.current.liveStartedAtMs,
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
      persistJobRebuffer(jobId, rebufferRef.current);
      detachHtmlMonitors();
      diagReporter.stop();
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
  }, [url, playbackGate, jobStatus, jobId, waitingForEncodeSlot, encodeQueueAhead]);

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

  function handleGoLive() {
    const e2e = captureAnchoredE2eMs();
    const elapsed = elapsedSecFromStart(encodeStartedAtEpoch);
    goLiveRef.current = latchGoLive(goLiveRef.current, elapsed, e2e);
    const engine = lowLatencyMode ? "ll-hls" : "hls";
    const result = seekGoLive(
      videoRef.current,
      goLiveHoldSec(engine, hlsTargetDurationRef.current),
      hlsLiveRef.current?.liveSyncPosition,
    );
    setDiagLines((current) => [...current.slice(-12), formatGoLiveDiag(result, elapsed, e2e)]);
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
        <GoLiveButton visible disabled={playbackGate !== "live"} onGoLive={handleGoLive} />
        {playbackGate === "live" && (
          <span className="hint player-elapsed">Elapsed {formatElapsed(elapsedSec)}</span>
        )}
      </div>
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
      </div>
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
