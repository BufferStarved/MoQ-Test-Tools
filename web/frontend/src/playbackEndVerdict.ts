/**
 * End-of-run playback coverage. The configured encode cap (often 300s)
 * is not the media the player was supposed to finish when the operator
 * hits Stop or the encode is cancelled — leftover unused duration is
 * not a stall.
 */

export function encodeElapsedSecForVerdict(options: {
  latestElapsedSec?: number | null;
  sampleElapsedSecs?: Array<number | null | undefined>;
  startedAtEpoch?: number | null;
  completedAtMs?: number | null;
  nowMs?: number;
}): number {
  const fromSamples = Math.max(
    0,
    options.latestElapsedSec ?? 0,
    ...(options.sampleElapsedSecs ?? []).map((value) => value ?? 0),
  );
  if (fromSamples > 0) {
    return fromSamples;
  }
  const start = options.startedAtEpoch ?? 0;
  if (start > 0) {
    const endMs = options.completedAtMs ?? options.nowMs ?? Date.now();
    return Math.max(0, endMs / 1000 - start);
  }
  return 0;
}

export function encodeDurationForEndVerdict(options: {
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): number {
  const planned = Math.max(0, options.encodeDurationSec ?? 0);
  const elapsed = Math.max(0, options.encodeElapsedSec ?? 0);
  if (elapsed > 0 && (options.runStopped || (planned > 0 && elapsed < planned * 0.8))) {
    return elapsed;
  }
  if (options.runStopped && elapsed <= 0) {
    return 0;
  }
  return planned;
}

export function encodeDurationLabel(sec: number): string {
  if (!(sec > 0)) {
    return "0";
  }
  if (sec >= 10) {
    return String(Math.round(sec));
  }
  return sec.toFixed(1);
}

export function playbackCoveredEncode(options: {
  videoTimeSec?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): boolean {
  const duration = encodeDurationForEndVerdict(options);
  const vt = options.videoTimeSec ?? 0;
  if (!(duration > 0)) {
    return false;
  }
  return vt >= duration * 0.8;
}

export function stallAgainstEncodeMessage(options: {
  protocolLabel: string;
  videoTimeSec?: number;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}): string {
  const vt = options.videoTimeSec ?? 0;
  const duration = encodeDurationForEndVerdict(options);
  if (duration > 0) {
    return `${options.protocolLabel} playback stalled at ${vt.toFixed(1)}s of a ${encodeDurationLabel(duration)}s encode.`;
  }
  return `${options.protocolLabel} playback stalled at ${vt.toFixed(1)}s.`;
}
