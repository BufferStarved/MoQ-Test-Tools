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

export function mpegTsMayMarkPlaybackOk(options: {
  paintedOk: boolean;
  lastReason?: string | null;
}): boolean {
  if (/manifest unreachable|HTTP |timed out|origin may be frozen/i.test(options.lastReason || "")) {
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

/** Honest connect_probe failure — do not call a timeout "manifest unreachable". */
export function mpegTsProbeFailReason(options: {
  httpStatus?: number | null;
  fetchError?: string | null;
  originHost?: string;
}): string {
  const err = (options.fetchError || "").toLowerCase();
  const host = (options.originHost || "").trim() || "the HTTP-TS origin";
  if (
    options.httpStatus === 504 ||
    /timeout|timed out|aborted/.test(err) ||
    /playback fetch timed out/i.test(err)
  ) {
    return (
      `HTTP-TS probe timed out — ${host} did not respond ` +
      `(origin may be frozen). This is not playback OK.`
    );
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
