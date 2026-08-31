/**
 * MPEG-TS / HTTP-TS end status. Comparison 29 marked Playback OK after
 * eight "manifest unreachable" probes with zero rendered frames.
 */

import { playbackCoveredEncode, stallAgainstEncodeMessage } from "./playbackEndVerdict.ts";

export function mpegTsPaintedOk(options: {
  ttffMs?: number;
  framesRendered?: number;
  videoWidth?: number;
}): boolean {
  return (
    (options.ttffMs ?? 0) > 0 &&
    ((options.framesRendered ?? 0) > 0 || (options.videoWidth ?? 0) > 0)
  );
}

/**
 * Webcam helper encodes frames on the laptop (UDP broker) before Zixi
 * :7777 has packets. encode_frames_total > 0 is not "origin has media".
 * Idle HTTP-TS while the job is still running/queued/pending must hold
 * reconnects — otherwise MAX_RECONNECTS burns and the tile goes Failed.
 */
export function mpegTsIdleWhileEncodePending(options: {
  encodeFramesTotal?: number | null;
  jobStatus?: string;
  lastReason?: string | null;
}): boolean {
  const status = (options.jobStatus || "").toLowerCase();
  if (status !== "running" && status !== "queued" && status !== "pending") {
    return false;
  }
  return /sent no media|idle HTTP-TS|unbounded stream/i.test(options.lastReason || "");
}

/** Helper SRT: do not probe :7777 until ffmpeg has actually produced frames. */
export function mpegTsShouldWaitForEncode(options: {
  encodeFramesTotal?: number | null;
  previewReady?: boolean;
  skipConnectProbe?: boolean;
  jobStatus?: string;
}): boolean {
  if (options.skipConnectProbe || options.previewReady) {
    return false;
  }
  const frames = options.encodeFramesTotal ?? 0;
  const status = (options.jobStatus || "").toLowerCase();
  if (status === "running" || status === "queued" || status === "pending") {
    return frames <= 0;
  }
  return false;
}

/** Idle 200+0-byte probes must not burn the reconnect budget before encode. */
export function mpegTsMayExhaustReconnects(options: {
  encodeFramesTotal?: number | null;
  jobStatus?: string;
  lastReason?: string | null;
}): boolean {
  return !mpegTsIdleWhileEncodePending(options);
}

export function mpegTsMayMarkPlaybackOk(options: {
  paintedOk: boolean;
  lastReason?: string | null;
}): boolean {
  if (
    /manifest unreachable|HTTP |timed out|origin may be frozen|sent no media|idle HTTP-TS/i.test(
      options.lastReason || "",
    )
  ) {
    return false;
  }
  return options.paintedOk;
}

/** Host:port from a raw HTTP-TS URL or an /api/playback/fetch proxy URL. */
export function mpegTsOriginHost(playbackUrl: string): string {
  const trimmed = (playbackUrl || "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    const fromProxy = trimmed.includes("/api/playback/fetch")
      ? new URL(trimmed, "http://local.invalid").searchParams.get("url") || trimmed
      : trimmed;
    return new URL(fromProxy).host;
  } catch {
    return "";
  }
}

/** Host-down / no HTTP status. Origin never answered. */
export function mpegTsFrozenOriginReason(host: string): string {
  return (
    `HTTP-TS probe timed out — ${host} did not respond ` +
    `(origin may be frozen). This is not playback OK.`
  );
}

/**
 * Headers arrived (HTTP 200 or equivalent) but the body never started.
 * Zixi live HTTP-TS does this when the named output is idle: 200 +
 * INT64_MAX Content-Length or no Content-Length, then 0 TS bytes.
 */
export function mpegTsIdleOriginReason(host: string, httpStatus = 200): string {
  return (
    `HTTP-TS origin ${host} answered HTTP ${httpStatus} but sent no media ` +
    `(live HTTP-TS idle, or advertised an unbounded stream with no packets). ` +
    `This is not playback OK.`
  );
}

/** Decode /api/playback/fetch idle vs host-down signaling. */
export function mpegTsFetchIdleSignal(options: {
  httpStatus?: number | null;
  upstreamStatusHeader?: string | null;
  firstByteHeader?: string | null;
  detail?: string | null;
}): { upstreamStatus: number | null; firstByteTimeout: boolean } {
  const raw = Number(options.upstreamStatusHeader || "");
  const fromHeader = Number.isFinite(raw) && raw > 0 ? raw : null;
  const idleHeader = (options.firstByteHeader || "").trim().toLowerCase() === "idle";
  const detail = options.detail || "";
  const fromDetail = /answered HTTP (\d+) but sent no media/i.exec(detail);
  if (idleHeader || fromDetail) {
    return {
      upstreamStatus: fromHeader ?? (fromDetail ? Number(fromDetail[1]) : 200),
      firstByteTimeout: true,
    };
  }
  if (fromHeader) {
    return { upstreamStatus: fromHeader, firstByteTimeout: false };
  }
  return { upstreamStatus: null, firstByteTimeout: false };
}

/** Honest connect_probe failure — do not call a timeout "manifest unreachable". */
export function mpegTsProbeFailReason(options: {
  httpStatus?: number | null;
  fetchError?: string | null;
  originHost?: string;
  upstreamStatus?: number | null;
  firstByteTimeout?: boolean;
  headersReceived?: boolean;
  bytesReceived?: number | null;
}): string {
  const err = (options.fetchError || "").toLowerCase();
  const host = (options.originHost || "").trim() || "the HTTP-TS origin";
  const timedOut =
    options.httpStatus === 504 ||
    options.firstByteTimeout === true ||
    /timeout|timed out|aborted/.test(err) ||
    /playback fetch timed out/i.test(err);
  const answeredStatus =
    options.upstreamStatus && options.upstreamStatus >= 200
      ? options.upstreamStatus
      : options.httpStatus === 200
        ? 200
        : null;
  const originAnswered =
    options.firstByteTimeout === true ||
    options.headersReceived === true ||
    answeredStatus != null ||
    (options.bytesReceived === 0 && options.httpStatus === 200);
  const noMedia =
    options.firstByteTimeout === true ||
    options.bytesReceived === 0 ||
    (originAnswered && timedOut);
  if (originAnswered && noMedia) {
    return mpegTsIdleOriginReason(host, answeredStatus ?? 200);
  }
  if (timedOut) {
    return mpegTsFrozenOriginReason(host);
  }
  if (options.httpStatus) {
    return `HTTP ${options.httpStatus}`;
  }
  return "manifest unreachable";
}

export type MpegTsEndVerdict =
  | { ok: true; status: "Playback OK"; error: null }
  | { ok: false; status: "Failed"; error: string };

/** Encode-over with 0 paint is a failure, not "Encode finished". */
export function classifyMpegTsEndVerdict(options: {
  paintedOk: boolean;
  lastReason?: string | null;
  videoTimeSec?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): MpegTsEndVerdict {
  if (mpegTsMayMarkPlaybackOk(options)) {
    if (
      (options.encodeDurationSec || options.encodeElapsedSec) &&
      !playbackCoveredEncode({
        videoTimeSec: options.videoTimeSec,
        encodeDurationSec: options.encodeDurationSec,
        encodeElapsedSec: options.encodeElapsedSec,
        runStopped: options.runStopped,
      })
    ) {
      return {
        ok: false,
        status: "Failed",
        error: stallAgainstEncodeMessage({
          protocolLabel: "MPEG-TS",
          videoTimeSec: options.videoTimeSec,
          encodeDurationSec: options.encodeDurationSec,
          encodeElapsedSec: options.encodeElapsedSec,
          runStopped: options.runStopped,
        }),
      };
    }
    return { ok: true, status: "Playback OK", error: null };
  }
  const last = (options.lastReason || "").trim();
  return {
    ok: false,
    status: "Failed",
    error: last
      ? `MPEG-TS playback stopped (${last}). Refresh or restart the publish.`
      : "MPEG-TS never painted. Encode-only is not playback.",
  };
}
