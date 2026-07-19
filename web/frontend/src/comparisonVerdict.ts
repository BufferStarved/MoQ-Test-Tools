import { protocolLabel } from "./protocolTheme";
import type { ResultSummary } from "./types";

export interface VerdictHighlight {
  /** Short metric name shown in the board, e.g. "Fastest join". */
  label: string;
  /** Winning stream label / protocol. */
  winner: string;
  /** Human-readable value, e.g. "420 ms". */
  value: string;
  protocol?: string;
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

  const ttff = pickLowest(streams, (r) => r.averages.playback_ttff_ms);
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

  const stalls = pickLowestOrZero(streams, (r) => r.averages.playback_stall_count);
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

  const e2e = pickLowest(streams, (r) => r.averages.e2e_latency_ms);
  if (e2e) {
    const name = streamName(streams[e2e.index], e2e.index, labels);
    highlights.push({
      label: "Lowest E2E",
      winner: name,
      value: formatMs(e2e.value),
      protocol: streams[e2e.index].protocol,
    });
    parts.push(`${name} lowest E2E (${formatMs(e2e.value)})`);
  }

  const vmaf = pickHighest(
    streams,
    (r) => r.quality?.ingest?.vmaf_score ?? r.averages.vmaf_score ?? r.quality?.encoder?.vmaf_score,
  );
  if (vmaf) {
    const name = streamName(streams[vmaf.index], vmaf.index, labels);
    highlights.push({
      label: "Best VMAF",
      winner: name,
      value: vmaf.value.toFixed(1),
      protocol: streams[vmaf.index].protocol,
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
