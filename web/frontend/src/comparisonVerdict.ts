import { protocolLabel } from "./protocolTheme";
import type { ResultSummary } from "./types";
import { isPlausibleE2eMs, playbackFpsFromCounters } from "./glassLatency";

export interface VerdictHighlight {
  /** Short metric name shown in the board, e.g. "Fastest join". */
  label: string;
  /** Winning stream label / protocol. */
  winner: string;
  /** Human-readable value, e.g. "420 ms". */
  value: string;
  /** Nullable to match `ResultSummary.protocol`, which the API can return null. */
  protocol?: string | null;
}

export interface ComparisonVerdict {
  /** One plain-language sentence for architects. */
  headline: string;
  highlights: VerdictHighlight[];
}

function finitePositive(value?: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function finiteNonNeg(value?: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function streamName(result: ResultSummary, index: number, labels?: string[]): string {
  if (labels?.[index]) {
    return labels[index];
  }
  if (result.summary_extra?.stream_label) {
    return result.summary_extra.stream_label;
  }
  return protocolLabel(result.protocol);
}

function pickLowest(
  streams: ResultSummary[],
  read: (r: ResultSummary) => number | undefined | null,
): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  streams.forEach((result, index) => {
    const value = read(result);
    if (!finitePositive(value)) {
      return;
    }
    if (!best || value < best.value) {
      best = { index, value };
    }
  });
  return best;
}

function pickLowestOrZero(
  streams: ResultSummary[],
  read: (r: ResultSummary) => number | undefined | null,
): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  streams.forEach((result, index) => {
    const value = read(result);
    if (!finiteNonNeg(value)) {
      return;
    }
    if (!best || value < best.value) {
      best = { index, value };
    }
  });
  return best;
}

function pickHighest(
  streams: ResultSummary[],
  read: (r: ResultSummary) => number | undefined | null,
): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  streams.forEach((result, index) => {
    const value = read(result);
    if (!finitePositive(value)) {
      return;
    }
    if (!best || value > best.value) {
      best = { index, value };
    }
  });
  return best;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function streamRtt(result: ResultSummary): number | undefined {
  const avg = result.averages ?? {};
  const rtt = avg.net_rtt_ms || avg.transport_rtt_ms || avg.quic_rtt_ms;
  return finitePositive(rtt) ? rtt : undefined;
}

function streamPlaybackFps(result: ResultSummary): number | undefined {
  const avg = result.averages ?? {};
  if (finitePositive(avg.playback_fps)) {
    return avg.playback_fps;
  }
  return playbackFpsFromCounters(
    avg.playback_frames_rendered ?? 0,
    Math.max(result.samples ?? 0, avg.playback_video_time_sec ?? 0),
  );
}

/**
 * Derive a short, decision-oriented verdict from a finished comparison.
 * Prefers join time, stalls, and glass-to-glass latency — the questions
 * architects ask first when choosing a protocol / host path.
 */
export function buildComparisonVerdict(
  streams: ResultSummary[],
  labels?: string[],
): ComparisonVerdict | null {
  if (streams.length < 2) {
    return null;
  }

  const highlights: VerdictHighlight[] = [];
  const parts: string[] = [];

  const ttff = pickLowest(streams, (r) => r.averages?.playback_ttff_ms);
  if (ttff) {
    const name = streamName(streams[ttff.index], ttff.index, labels);
    highlights.push({
      label: "Fastest join",
      winner: name,
      value: formatMs(ttff.value),
      protocol: streams[ttff.index].protocol,
    });
    parts.push(`${name} joined fastest (${formatMs(ttff.value)})`);
  }

  const stalls = pickLowestOrZero(streams, (r) => r.averages?.playback_stall_count);
  if (stalls) {
    const name = streamName(streams[stalls.index], stalls.index, labels);
    const value =
      stalls.value === 0 ? "0 stalls" : `${Math.round(stalls.value)} stall${stalls.value === 1 ? "" : "s"}`;
    highlights.push({
      label: "Smoothest playback",
      winner: name,
      value,
      protocol: streams[stalls.index].protocol,
    });
    if (stalls.value === 0) {
      parts.push(`${name} had no stalls`);
    } else {
      parts.push(`${name} had the fewest stalls (${value})`);
    }
  }

  // Glass delay: MoQ LOC uses CaptureTimestamp; WebRTC uses encode + RTT/2 +
  // jitter buffer; HLS/TS uses wall − encoder playhead. Same units, same
  // question (how late is the glass vs capture). Rank any plausible sample.
  const e2e = pickLowest(streams, (r) =>
    isPlausibleE2eMs(r.averages?.e2e_latency_ms) ? r.averages?.e2e_latency_ms : null,
  );
  if (e2e) {
    const name = streamName(streams[e2e.index], e2e.index, labels);
    highlights.push({
      label: "Lowest glass delay",
      winner: name,
      value: formatMs(e2e.value),
      protocol: streams[e2e.index].protocol,
    });
    parts.push(`${name} lowest glass delay (${formatMs(e2e.value)})`);
  }

  const rtt = pickLowest(streams, streamRtt);
  if (rtt) {
    const name = streamName(streams[rtt.index], rtt.index, labels);
    highlights.push({
      label: "Lowest RTT",
      winner: name,
      value: formatMs(rtt.value),
      protocol: streams[rtt.index].protocol,
    });
  }

  const fps = pickHighest(streams, streamPlaybackFps);
  if (fps) {
    const name = streamName(streams[fps.index], fps.index, labels);
    highlights.push({
      label: "Highest playback FPS",
      winner: name,
      value: `${fps.value.toFixed(1)} fps`,
      protocol: streams[fps.index].protocol,
    });
  }

  const dropped = pickLowestOrZero(streams, (r) => r.averages?.playback_frames_dropped);
  if (dropped && highlights.length < 7) {
    const name = streamName(streams[dropped.index], dropped.index, labels);
    highlights.push({
      label: "Fewest drops",
      winner: name,
      value:
        dropped.value === 0
          ? "0 dropped"
          : `${Math.round(dropped.value)} dropped`,
      protocol: streams[dropped.index].protocol,
    });
  }

  const encoderVmaf = pickHighest(streams, (r) =>
    (r.quality?.encoder?.computed_on || "").toLowerCase() === "webrtc_qp"
      ? undefined
      : r.quality?.encoder?.vmaf_score,
  );
  if (encoderVmaf) {
    const name = streamName(streams[encoderVmaf.index], encoderVmaf.index, labels);
    highlights.push({
      label: "Best encoder VMAF",
      winner: name,
      value: encoderVmaf.value.toFixed(1),
      protocol: streams[encoderVmaf.index].protocol,
    });
  }
  const ingestVmaf = pickHighest(streams, (r) => r.quality?.ingest?.vmaf_score);
  if (ingestVmaf) {
    const name = streamName(streams[ingestVmaf.index], ingestVmaf.index, labels);
    highlights.push({
      label: "Best ingest VMAF",
      winner: name,
      value: ingestVmaf.value.toFixed(1),
      protocol: streams[ingestVmaf.index].protocol,
    });
  }

  if (highlights.length === 0) {
    return null;
  }

  const headline =
    parts.length > 0
      ? `${parts.slice(0, 2).join(" · ")}.`
      : "Comparison finished — review the scorecard below.";

  return { headline, highlights };
}

/** Live glance metrics from the latest sample while a run is in progress. */
export function liveGlanceMetrics(sample: {
  playback_ttff_ms?: number;
  playback_stall_count?: number;
  e2e_latency_ms?: number;
  net_rtt_ms?: number;
  transport_rtt_ms?: number;
} | null): { label: string; value: string }[] {
  if (!sample) {
    return [];
  }
  const out: { label: string; value: string }[] = [];
  const rtt = sample.net_rtt_ms ?? sample.transport_rtt_ms;
  if (finitePositive(rtt)) {
    out.push({ label: "RTT", value: `${Math.round(rtt)} ms` });
  }
  if (finitePositive(sample.e2e_latency_ms)) {
    out.push({ label: "E2E", value: `${Math.round(sample.e2e_latency_ms)} ms` });
  }
  if (finitePositive(sample.playback_ttff_ms)) {
    out.push({ label: "TTFF", value: `${Math.round(sample.playback_ttff_ms)} ms` });
  }
  if (finiteNonNeg(sample.playback_stall_count)) {
    out.push({ label: "Stalls", value: String(Math.round(sample.playback_stall_count)) });
  }
  return out.slice(0, 3);
}

export interface LiveMetricRank {
  values: (number | null)[];
  /** Set only when at least two legs have a numeric value. */
  bestIndex: number | null;
  /** Rounded delta vs the best value; null on the winner or when incomparable. */
  deltaVsBest: (number | null)[];
}

function rankLowerIsBetter(values: (number | null)[]): LiveMetricRank {
  const numeric: { index: number; value: number }[] = [];
  values.forEach((value, index) => {
    if (finitePositive(value)) {
      numeric.push({ index, value });
    }
  });
  if (numeric.length < 2) {
    return { values, bestIndex: null, deltaVsBest: values.map(() => null) };
  }
  let bestIndex = numeric[0].index;
  let bestValue = numeric[0].value;
  for (const item of numeric) {
    if (item.value < bestValue) {
      bestIndex = item.index;
      bestValue = item.value;
    }
  }
  return {
    values,
    bestIndex,
    deltaVsBest: values.map((value, index) => {
      if (index === bestIndex || !finitePositive(value)) {
        return null;
      }
      return Math.round(value - bestValue);
    }),
  };
}

/** Compare already-displayed live metrics. Lower is better. No new formulas. */
export function compareLiveMetrics(
  samples: Array<{
    e2e_latency_ms?: number;
    playback_ttff_ms?: number;
    net_rtt_ms?: number;
    transport_rtt_ms?: number;
  } | null>,
): { latency: LiveMetricRank; ttff: LiveMetricRank; rtt: LiveMetricRank } {
  return {
    latency: rankLowerIsBetter(samples.map((sample) => sample?.e2e_latency_ms ?? null)),
    ttff: rankLowerIsBetter(samples.map((sample) => sample?.playback_ttff_ms ?? null)),
    rtt: rankLowerIsBetter(
      samples.map((sample) => sample?.net_rtt_ms ?? sample?.transport_rtt_ms ?? null),
    ),
  };
}
