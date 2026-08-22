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
 * Three properties keep the attribution honest:
 *
 * - Disagreement is signed. `residualMs` is measured e2e the components cannot
 *   explain; `overcountMs` is components in excess of measured e2e. Only one
 *   can be non-zero. Clamping the residual at 0 made an over-attributing leg
 *   (Linode WebRTC, 2026-08-22: 1419 ms of components against a 35 ms e2e)
 *   look identical to one that reconciled.
 * - The chain is summed only over what the e2e estimator spans. WHEP's e2e is
 *   receiver-side and cannot see the sender's encode pipeline, so `e2eScope`
 *   decides which components may be added to it.
 * - A stage with no instrument is named in `unmeasured`, not reported as 0.
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

/**
 * What span a leg's `e2e_latency_ms` actually measures. Not cosmetic: it
 * decides which components may be summed against it.
 *
 * - `capture_to_glass`: wall now minus the encoder-timeline position of the
 *   frame on screen (HLS PDT, HTTP-TS, MoQ). All five stages are in scope.
 * - `ingest_to_glass`: a receiver-side estimate built only from what the
 *   viewer can see (WHEP: ICE RTT/2 + jitterBufferDelay). The sender pipeline
 *   is invisible to it, so `latency_encode_ms` is reported but not summed.
 */
export const E2E_SCOPE_CAPTURE_TO_GLASS = "capture_to_glass";
export const E2E_SCOPE_INGEST_TO_GLASS = "ingest_to_glass";
export type E2eScope = typeof E2E_SCOPE_CAPTURE_TO_GLASS | typeof E2E_SCOPE_INGEST_TO_GLASS;

const OUT_OF_SCOPE: Record<string, readonly LatencyComponentKey[]> = {
  [E2E_SCOPE_INGEST_TO_GLASS]: ["latency_encode_ms"],
};

/** Above this a "component" is a clock/parse artifact, not a pipeline stage. */
const COMPONENT_MAX_MS = 60_000;

/**
 * Measured glass delay gets a much wider window than a single stage — a badly
 * broken leg really can sit at 37s and the total must survive to be charted.
 * Matches glassLatency.E2E_MAX_MS and playback_metrics.E2E_MAX_MS.
 */
const E2E_MAX_MS = 180_000;

/**
 * Above `ceiling` the number is a parse/clock artifact, so it is dropped to 0
 * rather than clamped to the ceiling: clamping turns a nonsense 70s reading
 * into a confident 60s component that stacks and sums like a real one.
 */
function cleanMs(value: number | null | undefined, ceiling = COMPONENT_MAX_MS): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number <= 0 || number > ceiling) {
    return 0;
  }
  return number;
}

export interface LatencyBudget {
  encodeMs: number;
  publishMs: number;
  networkMs: number;
  packagerMs: number;
  playerBufferMs: number;
  e2eMs: number;
  e2eScope: E2eScope;
  accountedMs: number;
  residualMs: number;
  /** In-scope components in excess of measured e2e. A modelling bug, shown. */
  overcountMs: number;
  /** Stages with no instrument on this leg; 0 here means unknown, not zero. */
  unmeasured: LatencyComponentKey[];
}

export interface LatencyBudgetInput {
  /** Constant capture→muxed offset that encode-lag charts subtract out. */
  pipelineBaselineMs?: number | null;
  encodeLagMs?: number | null;
  /**
   * Steady-state muxed→ingest transit. No protocol produces one yet; it is
   * NOT `upload_latency_ms`, which is a one-shot startup figure and inflated
   * every sample's total when it was wired here.
   */
  publishTransitMs?: number | null;
  netRttMs?: number | null;
  packagerTransitMs?: number | null;
  /** Seconds queued AHEAD of the playhead only — never LOC "behind live". */
  playbackBufferSec?: number | null;
  e2eLatencyMs?: number | null;
  e2eScope?: E2eScope;
}

/**
 * Capture→muxed delay: constant pipeline offset plus sustained lag.
 *
 * EncodeLagTracker reports only the *growth* of (wall − out_time) so its chart
 * answers "is the encoder falling further behind". The offset it subtracts
 * (x264 lookahead, mux buffering, device/broker warmup) is still real glass
 * delay, so the budget adds it back here — exactly once.
 *
 * This is a *sender-side* quantity; whether it may be added to a leg's e2e
 * depends on that leg's `e2eScope`.
 */
export function encodeLatencyMs(input: LatencyBudgetInput): number {
  return round1(cleanMs(input.pipelineBaselineMs) + cleanMs(input.encodeLagMs));
}

/**
 * One-way path estimate = RTT/2 (symmetric-path assumption).
 *
 * The only network figure available on most protocols — libsrt, RTMP TCP
 * probe, WebRTC ICE — so normalizing on it keeps the component comparable even
 * though the underlying measurement differs. MoQ has no RTT source wired, so
 * MoQ legs report this stage as unmeasured rather than as a 0 ms hop.
 */
export function networkLatencyMs(netRttMs: number | null | undefined): number {
  return round1(cleanMs(netRttMs) / 2);
}

/**
 * Media queued AHEAD of the playhead, in ms. MoQ LOC's canvas has no HTML
 * buffer and instead reports seconds the glass is BEHIND live — the opposite
 * direction — which travels in its own `playback_behind_live_sec` field and
 * must never reach this function. A LOC leg that leaked it in here charted a
 * 10.9s "buffer" on the protocol that should have been lowest-latency.
 */
export function playerBufferLatencyMs(playbackBufferSec: number | null | undefined): number {
  return round1(cleanMs(Number(playbackBufferSec ?? 0) * 1000));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Which span this leg's `e2e_latency_ms` covers. Keyed on the *player*,
 * because that is what computes e2e: a WHIP publish watched through an LL-HLS
 * remux is measured by the HLS player and really is capture-to-glass.
 */
export function e2eScopeFor(
  protocol: string | null | undefined,
  playbackEngine?: string | null,
): E2eScope {
  const engine = (playbackEngine ?? "").trim().toLowerCase();
  if (engine) {
    return engine === "whep" ? E2E_SCOPE_INGEST_TO_GLASS : E2E_SCOPE_CAPTURE_TO_GLASS;
  }
  return (protocol ?? "").trim().toLowerCase() === "webrtc"
    ? E2E_SCOPE_INGEST_TO_GLASS
    : E2E_SCOPE_CAPTURE_TO_GLASS;
}

/**
 * `null` and `0` mean different things for the transit inputs: `null` is "no
 * instrument on this leg" and lands the stage in `unmeasured`, `0` is
 * "measured, and it was zero". Callers must not default a missing instrument
 * to 0 — that is how a named cost gets silently reported as free.
 */
export function buildLatencyBudget(input: LatencyBudgetInput): LatencyBudget {
  const e2eScope = input.e2eScope ?? E2E_SCOPE_CAPTURE_TO_GLASS;
  const unmeasured: LatencyComponentKey[] = [];
  if (input.publishTransitMs == null) unmeasured.push("latency_publish_ms");
  if (input.netRttMs == null) unmeasured.push("latency_network_ms");
  if (input.packagerTransitMs == null) unmeasured.push("latency_packager_ms");
  if (input.playbackBufferSec == null) unmeasured.push("latency_player_buffer_ms");

  const encodeMs = encodeLatencyMs(input);
  const publishMs = round1(cleanMs(input.publishTransitMs));
  const networkMs = networkLatencyMs(input.netRttMs);
  const packagerMs = round1(cleanMs(input.packagerTransitMs));
  const playerBufferMs = playerBufferLatencyMs(input.playbackBufferSec);
  const e2eMs = round1(cleanMs(input.e2eLatencyMs, E2E_MAX_MS));

  const skip = new Set<string>(OUT_OF_SCOPE[e2eScope] ?? []);
  const byKey: Record<LatencyComponentKey, number> = {
    latency_encode_ms: encodeMs,
    latency_publish_ms: publishMs,
    latency_network_ms: networkMs,
    latency_packager_ms: packagerMs,
    latency_player_buffer_ms: playerBufferMs,
  };
  const accountedMs = round1(
    LATENCY_COMPONENT_KEYS.filter((key) => !skip.has(key)).reduce(
      (sum, key) => sum + byKey[key],
      0,
    ),
  );

  // Two different facts, two columns. The residual is unattributed *time*, so
  // it cannot be negative; components exceeding e2e is a modelling error with
  // a different cause, and it only gets fixed if it is visible.
  const residualMs = e2eMs <= 0 ? 0 : round1(Math.max(0, e2eMs - accountedMs));
  const overcountMs = e2eMs <= 0 ? 0 : round1(Math.max(0, accountedMs - e2eMs));

  return {
    encodeMs,
    publishMs,
    networkMs,
    packagerMs,
    playerBufferMs,
    e2eMs,
    e2eScope,
    accountedMs,
    residualMs,
    overcountMs,
    unmeasured,
  };
}

/**
 * Share of measured glass delay each component explains, for stacked display.
 * Returns null when there is no e2e measurement — an unweighted stack of
 * components would imply a total we never measured.
 *
 * Out-of-scope components are omitted: stacking a sender-side encode stage on
 * top of a receiver-side e2e would draw a bar taller than the total it is
 * supposed to decompose. `overcount` is stacked instead of `residual` when the
 * parts exceed the measurement, so the chart never silently hides it.
 */
export function latencyBudgetShares(
  budget: LatencyBudget,
): Array<{
  key: LatencyComponentKey | "residual" | "overcount";
  label: string;
  ms: number;
  pct: number;
  unmeasured?: boolean;
}> | null {
  if (budget.e2eMs <= 0) {
    return null;
  }
  const skip = new Set<string>(OUT_OF_SCOPE[budget.e2eScope] ?? []);
  const unmeasured = new Set<string>(budget.unmeasured);
  const byKey: Record<LatencyComponentKey, number> = {
    latency_encode_ms: budget.encodeMs,
    latency_publish_ms: budget.publishMs,
    latency_network_ms: budget.networkMs,
    latency_packager_ms: budget.packagerMs,
    latency_player_buffer_ms: budget.playerBufferMs,
  };
  const parts: Array<{
    key: LatencyComponentKey | "residual" | "overcount";
    label: string;
    ms: number;
    unmeasured?: boolean;
  }> = LATENCY_COMPONENTS.filter((component) => !skip.has(component.key)).map((component) => ({
    key: component.key,
    label: component.label,
    ms: byKey[component.key],
    unmeasured: unmeasured.has(component.key),
  }));
  parts.push(
    budget.overcountMs > 0
      ? { key: "overcount", label: "Over-attributed", ms: budget.overcountMs }
      : { key: "residual", label: "Unattributed", ms: budget.residualMs },
  );
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

/** A delivery ratio far above 100% is a broken denominator, not a fast player. */
const DELIVERY_MAX_PCT = 1000;

/**
 * End-to-end frame yield over a window both counters actually share. The one
 * frame metric that spans the whole chain, and the only one that catches loss
 * in the middle (relay drop, packager gap, decoder flush) that neither
 * endpoint counter sees.
 *
 * Both inputs are cumulative counters that do not start or stop together: the
 * browser attaches seconds after ffmpeg and detaches before it. Dividing the
 * raw totals measured the *attach offset*, not delivery — the 2026-08-22
 * matrix read 3.6–10.1% on every leg with zero drops anywhere. Differencing
 * both counters against their value at player attach puts them on one window.
 *
 * `null` means "no shared window" — unknown, not zero. Not capped at 100%: a
 * player reading ahead means clock skew, and clamping that to a perfect score
 * hides it.
 */
export function frameDeliveryPct(
  encodeFramesTotal: number | null | undefined,
  playbackFramesRendered: number | null | undefined,
  encodeFramesAtAttach?: number | null,
  playbackFramesAtAttach?: number | null,
): number | null {
  if (encodeFramesAtAttach == null) {
    return null;
  }
  const count = (value: number | null | undefined) =>
    Math.max(0, Math.trunc(Number(value ?? 0)) || 0);
  const encodedWindow = count(encodeFramesTotal) - count(encodeFramesAtAttach);
  const renderedWindow = count(playbackFramesRendered) - count(playbackFramesAtAttach);
  if (encodedWindow <= 0 || renderedWindow < 0) {
    return null;
  }
  const pct = Math.round((renderedWindow / encodedWindow) * 100 * 100) / 100;
  return pct > DELIVERY_MAX_PCT ? null : pct;
}
