/**
 * Per-component latency decomposition — browser mirror of src/latency_budget.py.
 *
 * A single glass-delay number says a leg is slow but never where the time
 * went, and each protocol estimates e2e differently (LOC CaptureTimestamp,
 * HLS PDT, wall−playhead, encode+RTT/2), so comparing totals alone can
 * mislead. These components are reported in the same units by every protocol:
 *
 *   capture ──encode──> muxed ──publish──> ingest ──packager──> delivery
 *           ──network──> player ──buffer──> glass
 *
 * `residualMs` is part of the model on purpose: measured e2e minus what we can
 * attribute. A large residual means the estimate and the parts disagree, which
 * is far more useful than folding the gap into whichever component is charted.
 */

export const LATENCY_COMPONENT_KEYS = [
  "latency_encode_ms",
  "latency_publish_ms",
  "latency_network_ms",
  "latency_packager_ms",
  "latency_player_buffer_ms",
] as const;

export type LatencyComponentKey = (typeof LATENCY_COMPONENT_KEYS)[number];

/** Chain order + display copy. Keep in sync with METRIC_DEFINITIONS. */
export const LATENCY_COMPONENTS: Array<{
  key: LatencyComponentKey;
  label: string;
  stage: string;
}> = [
  { key: "latency_encode_ms", label: "Encode", stage: "capture → muxed" },
  { key: "latency_publish_ms", label: "Publish", stage: "muxed → ingest" },
  { key: "latency_network_ms", label: "Network", stage: "one-way path (RTT/2)" },
  { key: "latency_packager_ms", label: "Packager", stage: "ingest → delivery" },
  { key: "latency_player_buffer_ms", label: "Player buffer", stage: "delivery → glass" },
];

/** Above this a "component" is a clock/parse artifact, not a pipeline stage. */
const COMPONENT_MAX_MS = 60_000;

function cleanMs(value: number | null | undefined): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.min(number, COMPONENT_MAX_MS);
}

export interface LatencyBudget {
  encodeMs: number;
  publishMs: number;
  networkMs: number;
  packagerMs: number;
  playerBufferMs: number;
  e2eMs: number;
  accountedMs: number;
  residualMs: number;
}

export interface LatencyBudgetInput {
  /** Constant capture→muxed offset that encode-lag charts subtract out. */
  pipelineBaselineMs?: number | null;
  encodeLagMs?: number | null;
  uploadLatencyMs?: number | null;
  netRttMs?: number | null;
  packagerTransitMs?: number | null;
  playbackBufferSec?: number | null;
  e2eLatencyMs?: number | null;
}

/**
 * Capture→muxed delay: constant pipeline offset plus sustained lag.
 *
 * EncodeLagTracker reports only the *growth* of (wall − out_time) so its chart
 * answers "is the encoder falling further behind". The offset it subtracts
 * (x264 lookahead, mux buffering, device/broker warmup) is still real glass
 * delay, so the budget adds it back here — exactly once.
 */
export function encodeLatencyMs(input: LatencyBudgetInput): number {
  return round1(cleanMs(input.pipelineBaselineMs) + cleanMs(input.encodeLagMs));
}

/**
 * One-way path estimate = RTT/2 (symmetric-path assumption).
 *
 * The only network figure available on every protocol — libsrt, RTMP TCP
 * probe, WebRTC ICE, MoQ qlog/probe — so normalizing on it keeps the component
 * comparable even though the underlying measurement differs per protocol.
 */
export function networkLatencyMs(netRttMs: number | null | undefined): number {
  return round1(cleanMs(netRttMs) / 2);
}

/**
 * Media queued ahead of the playhead, in ms. HTML-media players only: MoQ LOC
 * puts "seconds the canvas is behind live" in the same column, a different
 * quantity, so LOC callers pass 0 rather than mixing the two.
 */
export function playerBufferLatencyMs(playbackBufferSec: number | null | undefined): number {
  return round1(cleanMs(Number(playbackBufferSec ?? 0) * 1000));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildLatencyBudget(input: LatencyBudgetInput): LatencyBudget {
  const encodeMs = encodeLatencyMs(input);
  const publishMs = round1(cleanMs(input.uploadLatencyMs));
  const networkMs = networkLatencyMs(input.netRttMs);
  const packagerMs = round1(cleanMs(input.packagerTransitMs));
  const playerBufferMs = playerBufferLatencyMs(input.playbackBufferSec);
  const e2eMs = round1(cleanMs(input.e2eLatencyMs));
  const accountedMs = round1(encodeMs + publishMs + networkMs + packagerMs + playerBufferMs);
  // Clamped at 0: a negative residual means the components over-count
  // (double-counted buffer, stale RTT), which is a modelling bug to fix at the
  // source rather than a latency to render.
  const residualMs = e2eMs <= 0 ? 0 : round1(Math.max(0, e2eMs - accountedMs));
  return {
    encodeMs,
    publishMs,
    networkMs,
    packagerMs,
    playerBufferMs,
    e2eMs,
    accountedMs,
    residualMs,
  };
}

/**
 * Share of measured glass delay each component explains, for stacked display.
 * Returns null when there is no e2e measurement — an unweighted stack of
 * components would imply a total we never measured.
 */
export function latencyBudgetShares(
  budget: LatencyBudget,
): Array<{ key: LatencyComponentKey | "residual"; label: string; ms: number; pct: number }> | null {
  if (budget.e2eMs <= 0) {
    return null;
  }
  const parts: Array<{ key: LatencyComponentKey | "residual"; label: string; ms: number }> = [
    { key: "latency_encode_ms", label: "Encode", ms: budget.encodeMs },
    { key: "latency_publish_ms", label: "Publish", ms: budget.publishMs },
    { key: "latency_network_ms", label: "Network", ms: budget.networkMs },
    { key: "latency_packager_ms", label: "Packager", ms: budget.packagerMs },
    { key: "latency_player_buffer_ms", label: "Player buffer", ms: budget.playerBufferMs },
    { key: "residual", label: "Unattributed", ms: budget.residualMs },
  ];
  const total = parts.reduce((sum, part) => sum + part.ms, 0) || budget.e2eMs;
  return parts.map((part) => ({
    ...part,
    pct: Math.round((part.ms / total) * 1000) / 10,
  }));
}

/**
 * Encoder-side drop rate against frames the encoder actually handled.
 *
 * Denominator is total + dropped (frames offered), not `fps × elapsed`: a
 * legitimately 24fps source is not dropping 20% of a 30fps expectation.
 * ffmpeg's own drop_frames counter is exact, so nothing is inferred.
 */
export function encodeFrameDropPct(
  framesTotal: number | null | undefined,
  framesDropped: number | null | undefined,
): number {
  const total = Math.max(0, Math.trunc(Number(framesTotal ?? 0)) || 0);
  const dropped = Math.max(0, Math.trunc(Number(framesDropped ?? 0)) || 0);
  const offered = total + dropped;
  if (offered <= 0) {
    return 0;
  }
  return Math.round(Math.min(100, (dropped / offered) * 100) * 1000) / 1000;
}

/**
 * Glass-side drop rate against frames that reached the player. Same
 * denominator convention as the encoder side (delivered = rendered + dropped),
 * which is what makes the two percentages directly comparable.
 */
export function playbackFrameDropPct(
  framesRendered: number | null | undefined,
  framesDropped: number | null | undefined,
): number {
  const rendered = Math.max(0, Math.trunc(Number(framesRendered ?? 0)) || 0);
  const dropped = Math.max(0, Math.trunc(Number(framesDropped ?? 0)) || 0);
  const delivered = rendered + dropped;
  if (delivered <= 0) {
    return 0;
  }
  return Math.round(Math.min(100, (dropped / delivered) * 100) * 1000) / 1000;
}

/**
 * End-to-end frame yield: painted frames as a share of encoded frames. The one
 * frame metric that spans the whole chain, and the only one that catches loss
 * in the middle (relay drop, packager gap, decoder flush) that neither
 * endpoint counter sees.
 */
export function frameDeliveryPct(
  encodeFramesTotal: number | null | undefined,
  playbackFramesRendered: number | null | undefined,
): number {
  const encoded = Math.max(0, Math.trunc(Number(encodeFramesTotal ?? 0)) || 0);
  const rendered = Math.max(0, Math.trunc(Number(playbackFramesRendered ?? 0)) || 0);
  if (encoded <= 0 || rendered <= 0) {
    return 0;
  }
  return Math.round(Math.min(100, (rendered / encoded) * 100) * 100) / 100;
}
