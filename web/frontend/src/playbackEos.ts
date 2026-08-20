/**
 * Encode-end vs mid-run failure. BBB/cloud playout is a 60s clip — when the
 * publisher stops, MPEG-TS LOADING_COMPLETE, MoQ RESET_STREAM, and WHEP ICE
 * close are successful EOS, not player crashes.
 */

import { playbackCoveredEncode } from "./playbackEndVerdict.ts";

export function encodeLooksFinished(options: {
  jobStatus?: string;
  benchmarkLoading?: boolean;
}): boolean {
  if (options.jobStatus === "completed" || options.jobStatus === "failed") {
    return true;
  }
  if (options.jobStatus === "running" || options.jobStatus === "queued") {
    return false;
  }
  return options.benchmarkLoading === false;
}

/** True when the playhead covered most of the published clip. */
export function playedMostOfEncode(options: {
  videoTimeSec?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): boolean {
  return playbackCoveredEncode(options);
}

/** HTTP-TS ended after frames were shown. */
export function isGracefulMpegTsEos(options: {
  playedOk: boolean;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  videoTimeSec?: number;
  encodeDurationSec?: number;
}): boolean {
  if (!options.playedOk) {
    return false;
  }
  return encodeLooksFinished(options) || playedMostOfEncode(options);
}

export function isGracefulMoqReset(options: {
  playedOk: boolean;
  code?: number;
  message?: string;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  videoTimeSec?: number;
  encodeDurationSec?: number;
}): boolean {
  if (!options.playedOk) {
    return false;
  }
  const text = options.message || "";
  const reset =
    options.code === 4096 || /RESET_STREAM|stream reset|connection clos/i.test(text);
  if (!reset) {
    return false;
  }
  // Job completion alone is not EOS: a mid-clip freeze sits dead until the
  // publisher closes, then RESET_STREAM looks like success (prod comparison
  // 2026-08-18: playhead stuck at 12s of a 60s encode, UI said Playback OK).
  return playedMostOfEncode(options);
}

export function isGracefulWhepDisconnect(options: {
  playedOk: boolean;
  iceState?: string;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  videoTimeSec?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): boolean {
  if (!options.playedOk) {
    return false;
  }
  const state = (options.iceState || "").toLowerCase();
  if (state !== "failed" && state !== "disconnected" && state !== "closed") {
    return false;
  }
  return playedMostOfEncode(options);
}

/** FastAPI and similar bodies show up as `{"detail":"..."}` in player errors. */
export function unwrapFastApiDetail(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return "";
  }
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as { detail?: unknown };
      if (typeof parsed?.detail === "string" && parsed.detail) {
        const prefix = trimmed.slice(0, jsonStart).trim().replace(/[:\s]+$/, "");
        return prefix ? `${prefix}: ${parsed.detail}` : parsed.detail;
      }
    } catch {
      /* not a JSON error body */
    }
  }
  return trimmed;
}
