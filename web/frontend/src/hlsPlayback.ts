/**
 * HLS / LL-HLS end status. Comparison 30 Linode MTX SRT encoded 1352 frames
 * and painted 0; the tile said "Encode finished" because the playlist 404'd
 * the whole run. Encode-only is not playback.
 */

import { playbackCoveredEncode, stallAgainstEncodeMessage } from "./playbackEndVerdict.ts";

export type HlsEndVerdict =
  | { ok: true; status: "Playback OK"; error: null }
  | { ok: false; status: "Failed (see diagnostics)"; error: string };

export function hlsPaintedOk(options: { maxVideoTime?: number }): boolean {
  return (options.maxVideoTime ?? 0) > 0.25;
}

export function classifyHlsEndVerdict(options: {
  maxVideoTime?: number;
  lastError?: string | null;
  manifestParsed?: boolean;
  fragmentLoads?: number;
  uniqueFragCount?: number;
  videoBuffers?: number;
  audioBuffers?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): HlsEndVerdict {
  if (hlsPaintedOk(options)) {
    if (options.runStopped) {
      return { ok: true, status: "Playback OK", error: null };
    }
    if (
      (options.encodeDurationSec || options.encodeElapsedSec) &&
      !playbackCoveredEncode({
        videoTimeSec: options.maxVideoTime,
        encodeDurationSec: options.encodeDurationSec,
        encodeElapsedSec: options.encodeElapsedSec,
        runStopped: options.runStopped,
      })
    ) {
      return {
        ok: false,
        status: "Failed (see diagnostics)",
        error: stallAgainstEncodeMessage({
          protocolLabel: "HLS",
          videoTimeSec: options.maxVideoTime,
          encodeDurationSec: options.encodeDurationSec,
          encodeElapsedSec: options.encodeElapsedSec,
          runStopped: options.runStopped,
        }),
      };
    }
    return { ok: true, status: "Playback OK", error: null };
  }
  const last = (options.lastError || "").trim();
  if (last) {
    return { ok: false, status: "Failed (see diagnostics)", error: last };
  }
  const fragmentLoads = options.fragmentLoads ?? 0;
  const hadManifest = Boolean(options.manifestParsed) || fragmentLoads > 0;
  if (options.manifestParsed && (options.videoBuffers ?? 0) === 0 && (options.audioBuffers ?? 0) > 0) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error:
        "HLS buffered audio only — video track never decoded. Zixi TS chunks are missing in-band SPS/PPS (ffprobe: non-existing PPS). Restart dev stack and re-encode; verify Server Probe shows probe_decode=ok.",
    };
  }
  if (hadManifest && fragmentLoads > 0 && (options.uniqueFragCount ?? 0) <= 1) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error:
        "HLS playlist stayed on one stale segment (chunk not advancing). Zixi HLS output is not rolling — run ./scripts/verify-zixi-srt-ingest.sh (must PASS). Fix Zixi HTTP :7777 HLS, not the browser player.",
    };
  }
  if (hadManifest && fragmentLoads > 0) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error:
        "HLS segments downloaded but video never advanced past 0s. Segments may lack decodable H.264 keyframes at chunk boundaries.",
    };
  }
  if (hadManifest) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: "HLS manifest loaded but no media segments were fetched during the encode.",
    };
  }
  return {
    ok: false,
    status: "Failed (see diagnostics)",
    error: "HLS manifest never loaded — origin 404 or unreachable. Encode-only is not playback.",
  };
}
