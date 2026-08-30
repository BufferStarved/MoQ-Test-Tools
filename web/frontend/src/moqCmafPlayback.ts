import { isGracefulMoqEncodeOver } from "./playbackEos.ts";
import { playbackCoveredEncode, stallAgainstEncodeMessage } from "./playbackEndVerdict.ts";

/**
 * CMAF (ffmpeg / openmoq-publisher) subscribe + end-of-run policy.
 *
 * moqx catalog is a one-shot group-0 object. Tearing down on 0x10
 * ("no such namespace or track") leaves a gap where the catalog is
 * published to nobody — then AbsoluteStart {0,0} retries see nothing.
 * Encode/CMAF metrics keep ticking; the player stays black with no error
 * (comparison CSV 2026-08-18: frames=0, ttff=0, error_count=0, e2e≠0).
 */

export const MOQ_ALL_TRACKS_REFUSED = 4867;
export const MOQ_SUBSCRIPTION_REFUSED = 4866;
export const MOQ_LOAD_FAILED = 4865;
/** Draft-18 SUBSCRIBE_ERROR "no such namespace or track" (playa may pass this raw). */
export const MOQ_NO_SUCH_NAMESPACE = 0x10;
/** playa / WebTransport "Connection lost" — transient, reconnect. */
export const MOQ_CONNECTION_LOST = 4099;

/** Stay connected through publisher-not-ready; do not burn the one-shot catalog. */
export const SUBSCRIBE_KEEPALIVE_ON_0X10 = true;

/** Fail the visible player if nothing rendered by then (fits a 60s BBB). */
export const MOQ_NO_MEDIA_TIMEOUT_MS = 15_000;
/**
 * Live namespace + empty first catalog: keep waiting for vide_1 live-write
 * instead of firing the one-shot miss at the 15s no-media floor.
 */
export const MOQ_CATALOG_REFRESH_WAIT_MS = 30_000;

/**
 * Starve hold: two 0.5s webcam groups. One-group 0.65s froze on a late IDR.
 * This is NOT the healthy live-edge — only sit here while the playhead is
 * frozen or the next IDR is late. Healthy CMAF must compete with WebRTC.
 */
export const CMAF_STARVE_HOLD_SEC = 1.15;
/** @deprecated Name kept for call sites; value is the starve hold, not live. */
export const CMAF_GOP_HOLD_FLOOR_SEC = CMAF_STARVE_HOLD_SEC;
/** Healthy live-edge: one-frame-class, GOP-aware. Not an HLS window. */
export const CMAF_HEALTHY_HOLD_FLOOR_SEC = 0.2;
export const CMAF_HEALTHY_HOLD_CEILING_SEC = 0.4;
/**
 * Start catching up just past the healthy hold. A 1.25s slack on a 1.15s
 * hold meant 1.0× through a 2.4s lead and looked like HLS.
 */
export const CMAF_CATCH_UP_START_SLACK_SEC = 0.15;
export const CMAF_CATCH_UP_STOP_SLACK_SEC = 0.05;
/**
 * Seek once lead is a few seconds of runaway. 30s never fired on a 6–10s
 * balloon (comparison 2026-08-23). The 7s seek froze only during a GOP-wait
 * hole — the watchdog skips seek while frozen.
 */
export const CMAF_SEEK_FLOOR_SEC = 2.5;
export const CMAF_SEEK_SLACK_SEC = 1.5;
/** Reach max catch-up well before a 6–10s MSE balloon. */
export const CMAF_CATCH_UP_SPAN_SEC = 1.5;
export const CMAF_MAX_CATCH_UP_RATE = 1.35;

export function moqLiveEdgePolicy(targetLatencyMs: number): {
  holdBehindSec: number;
  starveHoldSec: number;
  rateOnSec: number;
  rateOffSec: number;
  seekThresholdSec: number;
  catchUpSpanSec: number;
} {
  const requested = Math.max(0.15, (targetLatencyMs || 400) / 1000);
  // Cap at the healthy ceiling — a 2s HLS-style budget is not a MoQ target.
  const holdBehindSec = Math.min(
    CMAF_HEALTHY_HOLD_CEILING_SEC,
    Math.max(CMAF_HEALTHY_HOLD_FLOOR_SEC, requested),
  );
  const rateOnSec = holdBehindSec + CMAF_CATCH_UP_START_SLACK_SEC;
  const rateOffSec = holdBehindSec + CMAF_CATCH_UP_STOP_SLACK_SEC;
  const seekThresholdSec = Math.max(CMAF_SEEK_FLOOR_SEC, rateOnSec + CMAF_SEEK_SLACK_SEC);
  return {
    holdBehindSec,
    starveHoldSec: CMAF_STARVE_HOLD_SEC,
    rateOnSec,
    rateOffSec,
    seekThresholdSec,
    catchUpSpanSec: CMAF_CATCH_UP_SPAN_SEC,
  };
}

/** MSE still has a GOP-sized lead — do not tear down a live-edge join. */
export const CMAF_BUFFERED_HOLD_SEC = 0.35;
/** Playhead that has actually started (MSE join), not a reconnect reset. */
export const CMAF_JOINED_PLAYHEAD_SEC = 0.25;
/** Same class of late-frame floor as the previous inline CMAF config. */
export const CMAF_LATE_FRAME_THRESHOLD_MS = 400;

/**
 * How playa retrieves the catalog track.
 *
 * CMAF on current moqx is a one-shot group-0 object. Playa `auto` issues
 * SUBSCRIBE LargestObject + Joining FETCH. FETCH invalid-range parks in
 * indefinite empty-wait; a later one-shot object is not on the live tail
 * (headed `bench-c5fc1536`: namespace live, `video_time=0`, catalog pending).
 * Fallback AbsoluteStart then REJECTS MSF-01 (`initDataList`) unless the
 * explicit compatibility hatch is set. `subscribe` is that hatch:
 * AbsoluteStart{0,0}, no FETCH, accepts MSF-01.
 *
 * LOC live-writes the catalog and keeps the track fetchable — keep `auto`.
 */
export function moqCatalogBootstrap(
  mediaPackaging: "cmaf" | "loc",
): "auto" | "subscribe" {
  return mediaPackaging === "cmaf" ? "subscribe" : "auto";
}

/**
 * Live CMAF subscribe: NextGroupStart at the next keyframe, no joining
 * FETCH of the open group. moqx honored a warm-start / mid-stream FETCH
 * for one GOP (~0.5–1s) and never attached later groups — same stall as
 * LOC. Catalog init comes from the publisher; do not fetch the open GOP.
 * Revisit only after a headed check of estimator + policy + test scope.
 */
export function cmafSubscribeOptions(): {
  subscriptionFilter: { type: "NextGroupStart" };
  warmStartCurrentGroup: false;
  lateFrameThresholdMs: number;
} {
  return {
    subscriptionFilter: { type: "NextGroupStart" },
    warmStartCurrentGroup: false,
    lateFrameThresholdMs: CMAF_LATE_FRAME_THRESHOLD_MS,
  };
}

/** CMAF paints MSE on <video>; LOC paints WebCodecs on <canvas>. */
export function moqRenderSink(mediaPackaging: "cmaf" | "loc"): "video" | "canvas" {
  return mediaPackaging === "loc" ? "canvas" : "video";
}

/**
 * Playa `stats.latencyMs` is LOC CaptureTimestamp (Unix-epoch µs). CMAF
 * ffmpeg has no such stamp — feeding it into `computeMoqE2eMs` short-circuits
 * the encode-timeline estimator (comparison 26).
 */
export function playaLatencyForMoqE2e(
  mediaPackaging: "cmaf" | "loc",
  playaLatencyMs: number | undefined,
): number | undefined {
  if (mediaPackaging !== "loc") {
    return undefined;
  }
  return playaLatencyMs != null && playaLatencyMs > 0 ? playaLatencyMs : undefined;
}

export type CmafStallAction = "ok" | "hold" | "restart" | "give_up";

/**
 * Frozen-playhead watchdog for CMAF/MSE.
 *
 * Prod `0b1e1ac` / `100826e`: catalog ready, vt=2.97s, ahead=0.53s,
 * then `playhead_frozen_*_buffered_early_join` tore the session down.
 * Reconnects 2/3 and 3/3 came back at vt=0 (catalog/group gone) and
 * never recovered. A GOP-sized buffer at ~3s is a live-edge join
 * waiting for the next fragment — keep the session.
 */
export function classifyCmafPlayheadStall(input: {
  videoTimeSec: number;
  aheadSec: number;
  frozenMs: number;
  earlyWindow: boolean;
  sessionRestarts: number;
  maxRestarts?: number;
  retrying: boolean;
  stallLimitMs: number;
}): CmafStallAction {
  if (input.retrying) {
    return "ok";
  }
  if (input.frozenMs <= input.stallLimitMs) {
    return "ok";
  }
  const maxRestarts = input.maxRestarts ?? 3;
  const buffered = input.aheadSec >= CMAF_BUFFERED_HOLD_SEC;
  const joined = input.videoTimeSec >= CMAF_JOINED_PLAYHEAD_SEC;

  // Buffered hole / live-edge GOP wait. Restarting burns the one-shot
  // catalog and the next subscribe starts at vt=0.
  if (buffered) {
    return "hold";
  }
  // Early-join starvation or a reconnect that wiped MSE: keep-alive
  // (playa REQUEST_UPDATE) beats a session teardown.
  if (input.earlyWindow || !joined) {
    return "hold";
  }
  if (input.sessionRestarts < maxRestarts) {
    return "restart";
  }
  return "give_up";
}

export function isPublisherNotReadyError(code: number): boolean {
  return (
    code === MOQ_ALL_TRACKS_REFUSED ||
    code === MOQ_SUBSCRIPTION_REFUSED ||
    code === MOQ_LOAD_FAILED ||
    code === MOQ_NO_SUCH_NAMESPACE
  );
}

export function isSubscribeRejectedLog(text?: string | null): boolean {
  return /no such namespace or track|code[=:]?\s*0x10\b|subscribe.*rejected/i.test(
    text || "",
  );
}

/** True: leave the WebTransport session up so catalog group 0 can still arrive. */
export function shouldKeepSessionOnSubscribeError(options: {
  firstFrame: boolean;
  code: number;
}): boolean {
  return !options.firstFrame && isPublisherNotReadyError(options.code);
}

export function moqHasRenderedMedia(options: {
  firstFrame?: boolean;
  framesRendered?: number;
  videoTimeSec?: number;
  bitrateBps?: number;
  subscribeRejected?: boolean;
}): boolean {
  const frames = options.framesRendered ?? 0;
  // ca7bbb62 East: leftover rendered=1 + bitrate 0 is not paint.
  if (frames === 1 && (options.bitrateBps ?? 0) <= 0 && (options.videoTimeSec ?? 0) <= 0.25) {
    return false;
  }
  return Boolean(
    options.firstFrame ||
      frames > 0 ||
      (options.videoTimeSec ?? 0) > 0.25,
  );
}

/**
 * Catalog "ready" with zero selected video levels is not playback-ready.
 * Webcam live-write often delivers `{tracks:[]}` first; that must not
 * arm the post-ready frame watchdog or count as a headed success.
 */
export function isPlayableCatalogReady(options: {
  catalogReady?: boolean;
  videoLevels?: number;
}): boolean {
  return Boolean(options.catalogReady) && (options.videoLevels ?? 0) > 0;
}

export function noMediaTimeoutMs(encodeDurationSec: number): number {
  const durationMs = Math.max(0, encodeDurationSec) * 1000;
  if (durationMs > 0) {
    return Math.max(8_000, Math.min(MOQ_NO_MEDIA_TIMEOUT_MS, Math.round(durationMs * 0.4)));
  }
  return MOQ_NO_MEDIA_TIMEOUT_MS;
}

export function isCaptureOrPublishError(error?: string | null): boolean {
  if (!error) {
    return false;
  }
  const text = error.toLowerCase();
  return (
    text.includes("ffmpeg exited") ||
    text.includes("shared webcam capture") ||
    text.includes("avfoundation") ||
    text.includes("selected framerate") ||
    text.includes("code 251") ||
    text.includes("input/output error") ||
    text.includes("conversion failed") ||
    text.includes("opening input") ||
    text.includes("never announced namespace") ||
    text.includes("catalog is not live") ||
    text.includes("webtransport session never connected") ||
    text.includes("no connection_id") ||
    text.includes("did not connect to the relay") ||
    text.includes("camera i/o error") ||
    text.includes("publish i/o error") ||
    text.includes("ffmpeg i/o error") ||
    text.includes("[errno 5]") ||
    text.includes("moq5-fmp4-publish not found") ||
    text.includes("failed to start moq publisher") ||
    text.includes("moq5 publisher exited") ||
    text.includes("before webtransport connect") ||
    text.includes("endpoint connect failed") ||
    text.includes("sender attach failed") ||
    text.includes("obs websocket") ||
    text.includes("startstream failed") ||
    text.includes("openmoq-plugin") ||
    text.includes("rtmp publish failed") ||
    text.includes("whip publish failed") ||
    text.includes("srt publish failed")
  );
}

function publishKindFromError(
  error: string,
  protocol?: string | null,
): "moq" | "rtmp" | "webrtc" | "srt" | "other" {
  const proto = (protocol || "").toLowerCase();
  if (proto === "moq" || proto === "rtmp" || proto === "webrtc" || proto === "srt") {
    return proto;
  }
  const text = error.toLowerCase();
  if (/moq5|moq-relay|cmaf init|pipe:1/.test(text)) {
    return "moq";
  }
  if (/rtmp:\/\//.test(text) || /rtmp publish failed/.test(text)) {
    return "rtmp";
  }
  if (/\bwhip\b|\bwhep\b/.test(text)) {
    return "webrtc";
  }
  if (/srt:\/\//.test(text)) {
    return "srt";
  }
  return "other";
}

/** Tester-facing job error — capture failures must not read as a catalog miss. */
export function humanizeJobError(
  error?: string | null,
  options?: { protocol?: string | null },
): string | null {
  const raw = (error || "").trim();
  if (!raw) {
    return null;
  }
  if (/one-shot catalog miss|catalog object never reached/i.test(raw)) {
    return raw;
  }
  if (!isCaptureOrPublishError(raw)) {
    return raw;
  }
  const first = raw.split("\n")[0].replace(/\s+/g, " ").trim();
  const kind = publishKindFromError(raw, options?.protocol);
  const modeMatch =
    raw.match(/supported modes?\s*(?:are\s*)?:?\s*[^\n.]+/i) ||
    raw.match(/1920x1080@\d+fps/i);
  const mode = modeMatch ? modeMatch[0].replace(/^supported modes?\s*(?:are\s*)?:?\s*/i, "").trim() : "";
  if (/camera i\/o error|framerate|avfoundation|shared webcam/i.test(raw)) {
    return [
      "The camera on this laptop could not start, so nothing was published.",
      mode ? `This device reported: ${mode}.` : first,
      "This is not a player or catalog problem. Use Cloud playout or Browser, or a camera mode the device actually supports.",
    ].join(" ");
  }
  const ffmpegCode = raw.match(/ffmpeg(?: exited with code)?\s+(\d+)/i)?.[1];
  if (kind === "rtmp") {
    return ffmpegCode
      ? `RTMP publish failed (ffmpeg ${ffmpegCode}). The ingest closed the connection — this is not a MoQ publisher pipe.`
      : "RTMP publish failed. The ingest closed the connection — this is not a MoQ publisher pipe.";
  }
  if (kind === "webrtc") {
    return ffmpegCode
      ? `WHIP publish failed (ffmpeg ${ffmpegCode}). The MediaMTX WHIP session ended before encode finished.`
      : "WHIP publish failed. The MediaMTX WHIP session ended before encode finished.";
  }
  if (kind === "srt") {
    return ffmpegCode
      ? `SRT publish failed (ffmpeg ${ffmpegCode}). The ingest closed the connection.`
      : "SRT publish failed. The ingest closed the connection.";
  }
  if (/^\[errno 5\]\s*input\/output error$/i.test(raw) || /^input\/output error$/i.test(raw)) {
    return (
      "The publisher pipe closed before encode finished ([Errno 5] Input/output error). " +
      "This is not a camera or catalog problem."
    );
  }
  if (/publish i\/o error|ffmpeg i\/o error|closed publisher pipe/i.test(raw)) {
    return `The publisher pipe closed before encode finished (${first}). This is not a player or catalog problem.`;
  }
  if (/moq5 publisher exited|before webtransport connect|endpoint connect failed|sender attach failed/i.test(raw)) {
    return `The MoQ publisher exited before a live catalog (${first}). This is not a player or catalog problem.`;
  }
  if (/moq5-fmp4-publish not found|failed to start moq publisher/i.test(raw)) {
    return `The publisher never started (${first}). This is not a player or catalog problem.`;
  }
  if (/webtransport session never connected|no connection_id|did not connect to the relay/i.test(raw)) {
    return `The publisher ran but did not connect to the relay (${first}). This is not a player or catalog problem.`;
  }
  if (/never announced namespace|catalog is not live/i.test(raw)) {
    return first;
  }
  if (/obs websocket|startstream failed|openmoq-plugin|obs openmoq/i.test(raw)) {
    return first;
  }
  return first;
}

export function playerErrorForFailedJob(options: {
  jobStatus?: string;
  jobError?: string | null;
  protocol?: string | null;
}): string | null {
  const shown = humanizeJobError(options.jobError, { protocol: options.protocol });
  if (options.jobStatus === "failed") {
    return shown;
  }
  if (
    options.jobStatus === "completed" &&
    /cancelled while waiting for a cloud encode slot/i.test(options.jobError || "")
  ) {
    return shown;
  }
  // Pipe-close / ffmpeg 224 often lands while status is still "running".
  // Do not wait for the job to flip failed before telling the truth.
  if (isCaptureOrPublishError(options.jobError)) {
    return shown;
  }
  return null;
}

export function isTransientMoqSessionDrop(options: {
  code?: number | null;
  message?: string | null;
}): boolean {
  const code = options.code ?? 0;
  const text = options.message || "";
  return code === MOQ_CONNECTION_LOST || /connection lost/i.test(text);
}

export function shouldSkipMoqSessionRestart(options: {
  runStopped?: boolean;
  firstFrame?: boolean;
  videoTimeSec?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
}): boolean {
  if (options.runStopped) {
    return true;
  }
  return Boolean(options.firstFrame) && playbackCoveredEncode(options);
}

export function noMediaFailMessage(options: {
  catalogReady: boolean;
  namespace?: string;
  jobStatus?: string;
  jobError?: string | null;
  previewReady?: boolean;
  /** True when playa kept the session on 0x10 (no such namespace or track). */
  subscribeRejected?: boolean;
}): string {
  const jobFail = playerErrorForFailedJob(options);
  if (jobFail) {
    return jobFail;
  }
  if (options.catalogReady) {
    return "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.";
  }
  const ns = (options.namespace || "").trim();
  // 0x10 means the relay never had this namespace. preview_ready grace is
  // not a live announce — treating it as one-shot miss hid the pipe-close
  // (bench-2c3781c5: moqx_ns=0 the whole run, then ffmpeg 224).
  if (options.subscribeRejected) {
    return ns
      ? `MoQ publisher never announced namespace ${ns} on the relay (SUBSCRIBE 0x10). This is not a one-shot catalog miss.`
      : "MoQ publisher never announced the namespace on the relay (SUBSCRIBE 0x10). This is not a one-shot catalog miss.";
  }
  if (options.jobStatus === "completed" || options.jobStatus === "failed") {
    return ns
      ? `MoQ publisher never announced namespace ${ns} on the relay. Encode ran but the catalog is not live — this is not a player 0x10 miss.`
      : "MoQ publisher never announced the namespace on the relay. Encode ran but the catalog is not live — this is not a player 0x10 miss.";
  }
  // preview_ready is now moqx announce only. If that is true and playa
  // never saw 0x10, the catalog object itself missed this player.
  if (options.previewReady === true) {
    return ns
      ? `MoQ namespace ${ns} is live on the relay but the catalog object never reached this player (one-shot catalog miss).`
      : "MoQ namespace is live on the relay but the catalog object never reached this player (one-shot catalog miss).";
  }
  return ns
    ? `MoQ catalog never loaded on namespace ${ns}. Publisher must be live; a 0x10 subscribe miss is not OK.`
    : "MoQ catalog never loaded. Publisher must be live; a 0x10 subscribe miss is not OK.";
}

/** When the no-media watchdog may fail the visible player.

A 15s timeout while the job is still queued or the publisher has not
announced the namespace produces a catalog-miss toast for a queue /
publisher-death problem (bench-733f1d7c). Wait for encode-over.

A live namespace whose catalog is still empty (`{tracks:[]}` then vide_1)
is not a one-shot miss — FETCH/SUBSCRIBE must stay up for the later object
through `MOQ_CATALOG_REFRESH_WAIT_MS`. After that cap, sitting on
`Connecting…` / `video_time=0 (catalog pending)` with no UI error is a
player failure (headed success is rendered > 0, not “encode still running”).
*/
export function shouldFailNoMediaWatchdog(options: {
  jobStatus?: string;
  previewReady?: boolean;
  catalogReady?: boolean;
  liveMs: number;
  deadlineMs: number;
  subscribeRejected?: boolean;
}): boolean {
  const status = (options.jobStatus || "").toLowerCase();
  if (status === "queued" || status === "pending") {
    return false;
  }
  if (status === "completed" || status === "failed") {
    return true;
  }
  if (options.previewReady === false) {
    return false;
  }
  // 0x10 keepalive: the namespace was never live. Wait for encode-over so
  // the job error (pipe close, publisher exit) wins over a 30s miss toast.
  if (options.subscribeRejected && options.catalogReady === false) {
    return false;
  }
  // Live-write in flight: wait for vide_1, then fail if the catalog never
  // becomes playable. Do not wait the whole encode with no error.
  if (options.catalogReady === false) {
    return options.liveMs >= MOQ_CATALOG_REFRESH_WAIT_MS;
  }
  return options.liveMs >= options.deadlineMs;
}

export type MoqEndVerdict =
  | { ok: true; status: string; error: null }
  | { ok: false; status: "Failed (see diagnostics)"; error: string };

export function isNoMediaCatalogMessage(text?: string | null): boolean {
  return /catalog loaded but no video frames|catalog never loaded|0x10 subscribe miss|catalog object never reached/i.test(
    text || "",
  );
}

export function classifyMoqEndVerdict(options: {
  firstFrame?: boolean;
  framesRendered?: number;
  videoTimeSec?: number;
  catalogReady?: boolean;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
  sessionRestarts?: number;
  lastError?: string | null;
  namespace?: string;
  jobStatus?: string;
  jobError?: string | null;
  previewReady?: boolean;
  subscribeRejected?: boolean;
  bitrateBps?: number;
}): MoqEndVerdict {
  const jobFail = playerErrorForFailedJob(options);
  if (jobFail && !moqHasRenderedMedia(options)) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: jobFail,
    };
  }
  const played = moqHasRenderedMedia(options);
  const covered = playbackCoveredEncode(options);
  if (played && covered) {
    const restarts = options.sessionRestarts ?? 0;
    return {
      ok: true,
      status:
        restarts > 0
          ? `Playback ended (reconnected ${restarts}× after a freeze)`
          : "Playback OK",
      error: null,
    };
  }
  // Job completed / operator stop after first_frame: playhead_frozen is the
  // publisher stopping. Do not keep last_error as "stalled at Xs of a Ys encode".
  if (
    played &&
    isGracefulMoqEncodeOver({
      playedOk: true,
      jobStatus: options.jobStatus,
      runStopped: options.runStopped,
    })
  ) {
    return {
      ok: true,
      status: "Encode ended",
      error: null,
    };
  }
  if (played && !covered) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: stallAgainstEncodeMessage({
        protocolLabel: "MoQ",
        videoTimeSec: options.videoTimeSec,
        encodeDurationSec: options.encodeDurationSec,
        encodeElapsedSec: options.encodeElapsedSec,
        runStopped: options.runStopped,
      }),
    };
  }
  if (options.lastError && !(played && isNoMediaCatalogMessage(options.lastError))) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: options.lastError,
    };
  }
  return {
    ok: false,
    status: "Failed (see diagnostics)",
    error: noMediaFailMessage({
      catalogReady: Boolean(options.catalogReady),
      namespace: options.namespace,
      jobStatus: options.jobStatus,
      jobError: options.jobError,
      previewReady: options.previewReady,
      subscribeRejected: options.subscribeRejected,
    }),
  };
}
