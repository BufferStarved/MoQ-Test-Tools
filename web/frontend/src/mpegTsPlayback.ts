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
  if (/manifest unreachable|HTTP /i.test(options.lastReason || "")) {
    return false;
  }
  return options.paintedOk;
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
