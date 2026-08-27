import { protocolLabel } from "./protocolTheme.ts";
import type { ResultSummary } from "./types.ts";
import { isPlausibleE2eMs, playbackFpsFromCounters } from "./glassLatency.ts";
import {
  E2E_SCOPE_CAPTURE_TO_GLASS,
  E2E_SCOPE_CAPTURE_TO_INGEST,
  E2E_SCOPE_INGEST_TO_GLASS,
  e2eScopeFor,
  type E2eScope,
} from "./latencyBudget.ts";

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

export interface PaintLine {
  label: string;
  painted: boolean;
  frames: number;
  vmaf?: string;
}

export interface ComparisonVerdict {
  /** One plain-language sentence for architects. */
  headline: string;
  highlights: VerdictHighlight[];
  /** Per-leg paint / VMAF, not CSV averages (those can read as 0 after a real paint). */
  paintLines: PaintLine[];
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

export function e2eScopeShortLabel(scope: string | null | undefined): string {
  if (scope === E2E_SCOPE_INGEST_TO_GLASS) {
    return "ingest-to-glass";
  }
  if (scope === E2E_SCOPE_CAPTURE_TO_INGEST) {
    return "capture-to-ingest";
  }
  return "capture-to-glass";
}

export function e2eScopeHudLabel(scope: string | null | undefined): string {
  if (scope === E2E_SCOPE_INGEST_TO_GLASS) {
    return "Latency · ingest path";
  }
  if (scope === E2E_SCOPE_CAPTURE_TO_INGEST) {
    return "Latency · ingest path";
  }
  return "Latency · glass";
}

/** Ingest-to-glass + encode → a capture-class hint. Not a measured glass number. */
export function captureClassHintMs(
  e2eMs: number | null | undefined,
  encodeMs: number | null | undefined,
  scope?: string | null,
): number | undefined {
  if (scope != null && scope !== E2E_SCOPE_INGEST_TO_GLASS) {
    return undefined;
  }
  if (!finitePositive(e2eMs) || !finitePositive(encodeMs)) {
    return undefined;
  }
  return Math.round(e2eMs + encodeMs);
}

export function resolveSampleE2eScope(sample: {
  latency_e2e_scope?: string;
  protocol?: string | null;
  playback_engine?: string | null;
  test_scope?: string | null;
} | null | undefined): E2eScope {
  const raw = (sample?.latency_e2e_scope ?? "").trim();
  if (
    raw === E2E_SCOPE_INGEST_TO_GLASS ||
    raw === E2E_SCOPE_CAPTURE_TO_GLASS ||
    raw === E2E_SCOPE_CAPTURE_TO_INGEST
  ) {
    return raw;
  }
  return e2eScopeFor(sample?.protocol, sample?.playback_engine, sample?.test_scope);
}

function streamE2eScope(result: ResultSummary): E2eScope {
  return e2eScopeFor(
    result.protocol,
    result.summary_extra?.playback_engine,
    result.summary_extra?.test_scope || result.rows?.[0]?.test_scope,
  );
}

function streamRtt(result: ResultSummary): number | undefined {
  const avg = result.averages ?? {};
  const rtt = avg.net_rtt_ms || avg.transport_rtt_ms || avg.quic_rtt_ms;
  return finitePositive(rtt) ? rtt : undefined;
}

export function streamPaintedFrames(result: ResultSummary): number {
  let max = 0;
  for (const row of result.rows ?? []) {
    const n = Number(row.playback_frames_rendered ?? 0);
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  if (max > 0) {
    return max;
  }
  const avg = result.averages?.playback_frames_rendered;
  return Number.isFinite(avg) && (avg ?? 0) > 0 ? Math.round(avg as number) : 0;
}

function streamVmafLabel(result: ResultSummary): string | undefined {
  const ingest = result.quality?.ingest?.vmaf_score;
  const encoder = result.quality?.encoder?.vmaf_score;
  if (Number.isFinite(ingest) && (ingest ?? 0) > 0) {
    return `VMAF ${Number(ingest).toFixed(1)}`;
  }
  if (Number.isFinite(encoder) && (encoder ?? 0) > 0) {
    return `encoder VMAF ${Number(encoder).toFixed(1)}`;
  }
  return undefined;
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
  if (streams.length < 1) {
    return null;
  }

  const paintLines: PaintLine[] = streams.map((result, index) => {
    const frames = streamPaintedFrames(result);
    return {
      label: streamName(result, index, labels),
      painted: frames > 0,
      frames,
      vmaf: streamVmafLabel(result),
    };
  });

  if (streams.length < 2) {
    const line = paintLines[0];
    return {
      headline: line.painted
        ? `${line.label} painted (${line.frames} frames).`
        : `${line.label} showed no video.`,
      highlights: [],
      paintLines,
    };
  }

  const highlights: VerdictHighlight[] = [];
  const joinParts: string[] = [];
  const glassParts: string[] = [];

  const ttff = pickLowest(streams, (r) => r.averages?.playback_ttff_ms);
  if (ttff) {
    const name = streamName(streams[ttff.index], ttff.index, labels);
    highlights.push({
      label: "Fastest join",
      winner: name,
      value: formatMs(ttff.value),
      protocol: streams[ttff.index].protocol,
    });
    joinParts.push(`${name} joined fastest (${formatMs(ttff.value)})`);
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
      joinParts.push(`${name} had no stalls`);
    } else {
      joinParts.push(`${name} had the fewest stalls (${value})`);
    }
  }

  // Do not rank ingest-to-glass (WHEP) against capture-to-glass (MoQ/HLS)
  // as one "lowest glass delay". TTFF is join time, not glass — it stays
  // in "Fastest join" above.
  const scopesPresent = new Set<E2eScope>();
  streams.forEach((result) => {
    if (isPlausibleE2eMs(result.averages?.e2e_latency_ms)) {
      scopesPresent.add(streamE2eScope(result));
    }
  });
  for (const scope of [
    E2E_SCOPE_INGEST_TO_GLASS,
    E2E_SCOPE_CAPTURE_TO_GLASS,
    E2E_SCOPE_CAPTURE_TO_INGEST,
  ] as const) {
    if (!scopesPresent.has(scope)) {
      continue;
    }
    const e2e = pickLowest(streams, (r) =>
      streamE2eScope(r) === scope && isPlausibleE2eMs(r.averages?.e2e_latency_ms)
        ? r.averages?.e2e_latency_ms
        : null,
    );
    if (!e2e) {
      continue;
    }
    const name = streamName(streams[e2e.index], e2e.index, labels);
    const scopeLabel = e2eScopeShortLabel(scope);
    highlights.push({
      label: `Lowest ${scopeLabel}`,
      winner: name,
      value: formatMs(e2e.value),
      protocol: streams[e2e.index].protocol,
    });
    glassParts.push(`${name} lowest ${scopeLabel} (${formatMs(e2e.value)})`);
  }
  if (scopesPresent.size > 1) {
    const webrtc = streams.findIndex((r) => streamE2eScope(r) === E2E_SCOPE_INGEST_TO_GLASS);
    if (webrtc >= 0) {
      const hint = captureClassHintMs(
        streams[webrtc].averages?.e2e_latency_ms,
        streams[webrtc].averages?.latency_encode_ms,
        E2E_SCOPE_INGEST_TO_GLASS,
      );
      if (hint != null) {
        highlights.push({
          label: "WebRTC as capture-class",
          winner: streamName(streams[webrtc], webrtc, labels),
          value: `≈ ${formatMs(hint)} (ingest + encode)`,
          protocol: streams[webrtc].protocol,
        });
      }
    }
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

  const stalled = paintLines.filter((line) => !line.painted);
  const paintLead =
    stalled.length === 0
      ? "Every tile painted."
      : stalled.length === paintLines.length
        ? "No tile painted — catalog-ready is not success."
        : `${stalled.map((line) => line.label).join(", ")} showed no video.`;

  if (highlights.length === 0 && paintLines.length === 0) {
    return null;
  }

  // Lead with scoped glass so a mixed 4-way cannot read as "WebRTC wins
  // by 6s". TTFF is join time, not glass — it stays in the scorecard.
  const headlineParts = glassParts.length > 0 ? glassParts : joinParts;
  const headline =
    headlineParts.length > 0
      ? `${paintLead} ${headlineParts.slice(0, 2).join(" · ")}.`
      : paintLead;

  return { headline, highlights, paintLines };
}

/** Live glance metrics from the latest sample while a run is in progress. */
export function liveGlanceMetrics(sample: {
  playback_ttff_ms?: number;
  playback_stall_count?: number;
  e2e_latency_ms?: number;
  net_rtt_ms?: number;
  transport_rtt_ms?: number;
  latency_e2e_scope?: string;
  protocol?: string | null;
  playback_engine?: string | null;
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
    const scope = resolveSampleE2eScope(sample);
    out.push({
      label:
        scope === E2E_SCOPE_INGEST_TO_GLASS
          ? "E2E ingest"
          : scope === E2E_SCOPE_CAPTURE_TO_INGEST
            ? "E2E ingest path"
            : "E2E capture",
      value: `${Math.round(sample.e2e_latency_ms)} ms`,
    });
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
    latency_e2e_scope?: string;
    protocol?: string | null;
    playback_engine?: string | null;
  } | null>,
): { latency: LiveMetricRank; ttff: LiveMetricRank; rtt: LiveMetricRank } {
  const scopes = samples.map((sample) => (sample ? resolveSampleE2eScope(sample) : null));
  const rankedScopes = new Set(
    scopes.filter((scope, index) => scope && finitePositive(samples[index]?.e2e_latency_ms)),
  );
  // Mixed ingest vs capture: do not crown a winner or print "+6s".
  const latency =
    rankedScopes.size > 1
      ? {
          values: samples.map((sample) => sample?.e2e_latency_ms ?? null),
          bestIndex: null,
          deltaVsBest: samples.map(() => null),
        }
      : rankLowerIsBetter(samples.map((sample) => sample?.e2e_latency_ms ?? null));
  return {
    latency,
    ttff: rankLowerIsBetter(samples.map((sample) => sample?.playback_ttff_ms ?? null)),
    rtt: rankLowerIsBetter(
      samples.map((sample) => sample?.net_rtt_ms ?? sample?.transport_rtt_ms ?? null),
    ),
  };
}
