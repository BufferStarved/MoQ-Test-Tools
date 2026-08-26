/**
 * Per-component latency decomposition — browser mirror of src/latency_budget.py.
 *
 * A single glass-delay number says a leg is slow but never where the time
 * went, and each protocol estimates e2e differently (LOC CaptureTimestamp,
 * HLS PDT, wall−playhead, encode+RTT/2), so comparing totals alone can
 * mislead. These components are reported in the same units by every protocol:
 *
 *   capture ──encode──> muxed ──cmaf_group──> publish ──network──> ingest
 *           ──packager──> player_buffer──> glass
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
  "latency_segmentation_ms",
  "latency_publish_ms",
  "latency_network_ms",
  "latency_packager_ms",
  "latency_player_buffer_ms",
] as const;

/** MediaMTX LL-HLS part — the HLS object, not a 1s CMAF group. */
export const LL_HLS_PART_MS = 200;
/** Zixi Fast HLS segment floor (encode_profile.HLS_SEGMENT_SEC_MIN). */
export const FAST_HLS_SEGMENT_MS = 2000;
/** Shared webcam broker master IDR cadence. */
export const BROKER_GOP_MS = 1000;

export type LatencyComponentKey = (typeof LATENCY_COMPONENT_KEYS)[number];

/** Chain order + display copy. Keep in sync with METRIC_DEFINITIONS. */
export const LATENCY_COMPONENTS: Array<{
  key: LatencyComponentKey;
  label: string;
  stage: string;
}> = [
  { key: "latency_encode_ms", label: "Encode", stage: "capture → AU" },
  {
    key: "latency_segmentation_ms",
    label: "CMAF group (segmentation)",
    stage: "AU → closed group",
  },
  { key: "latency_publish_ms", label: "Publish", stage: "closed group → ingest" },
  { key: "latency_network_ms", label: "Network", stage: "one-way path (RTT/2)" },
  { key: "latency_packager_ms", label: "Packager", stage: "ingest → delivery" },
  { key: "latency_player_buffer_ms", label: "Player buffer", stage: "delivery → glass" },
];

/**
 * What span a leg's `e2e_latency_ms` actually measures. Not cosmetic: it
 * decides which components may be summed against it.
 *
 * - `capture_to_glass`: wall now minus the encoder-timeline position of the
 *   frame on screen (HLS PDT, HTTP-TS, MoQ). Encode + CMAF group + publish +
 *   network + packager + player_buffer are in scope.
 * - `ingest_to_glass`: a receiver-side estimate built only from what the
 *   viewer can see (WHEP: ICE RTT/2 + jitterBufferDelay). The sender pipeline
 *   is invisible to it, so encode and CMAF group are reported but not summed.
 * - `capture_to_ingest`: upload-only. Encode + CMAF group + publish + network
 *   + packager. Player buffer is out of scope — do not copy monitor glass.
 */
export const E2E_SCOPE_CAPTURE_TO_GLASS = "capture_to_glass";
export const E2E_SCOPE_INGEST_TO_GLASS = "ingest_to_glass";
export const E2E_SCOPE_CAPTURE_TO_INGEST = "capture_to_ingest";
export type E2eScope =
  | typeof E2E_SCOPE_CAPTURE_TO_GLASS
  | typeof E2E_SCOPE_INGEST_TO_GLASS
  | typeof E2E_SCOPE_CAPTURE_TO_INGEST;

const OUT_OF_SCOPE: Record<string, readonly LatencyComponentKey[]> = {
  [E2E_SCOPE_INGEST_TO_GLASS]: ["latency_encode_ms", "latency_segmentation_ms"],
  [E2E_SCOPE_CAPTURE_TO_INGEST]: ["latency_player_buffer_ms"],
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
  segmentationMs: number;
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
  /** Stages that do not exist on this protocol (WebRTC has no CMAF group). */
  notApplicable: LatencyComponentKey[];
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
  protocol?: string | null;
  playbackEngine?: string | null;
  /**
   * Known object/group duration (1s brokered MoQ, ~0.25s solo MoQ, 200ms
   * LL-HLS parts). `null` = unmeasured. Do not invent 0.
   */
  segmentationMs?: number | null;
  segmentationNotApplicable?: boolean;
  /**
   * Subtract group duration from encode when the ffmpeg baseline includes
   * GOP-close wait (MoQ fMP4). Overlay must leave this false — encode is
   * already the capture→AU component.
   */
  splitEncodeGop?: boolean;
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
 * depends on that leg's `e2eScope`. On MoQ, `splitEncodeGop` pulls GOP-close
 * wait out of this number so segmentation owns AU→closed group.
 */
export function encodeLatencyMs(input: LatencyBudgetInput): number {
  let total = cleanMs(input.pipelineBaselineMs) + cleanMs(input.encodeLagMs);
  if (input.splitEncodeGop) {
    const gop = cleanMs(input.segmentationMs);
    // Only peel GOP-close wait out of encode when the baseline actually
    // contains it. File-source -re advances out_time every frame (~40ms);
    // subtracting a 1s GOP zeros a real instrument.
    if (gop > 0 && cleanMs(input.pipelineBaselineMs) >= gop) {
      total = Math.max(0, total - gop);
    }
  }
  return round1(total);
}

/**
 * Object/group cadence for the CMAF-group hop. `[ms | null, notApplicable]`.
 * `null` + not n/a is unmeasured — never a confident 0. WebRTC has no group.
 * 0.5s/1s on MoQ CMAF is group duration (NextGroupStart), not ingest RTT.
 * LL-HLS parts are 200ms.
 */
export function resolveSegmentationMs(input: {
  protocol?: string | null;
  playbackEngine?: string | null;
  groupDurationMs?: number | null;
}): { ms: number | null; notApplicable: boolean } {
  const proto = (input.protocol ?? "").trim().toLowerCase();
  const engine = (input.playbackEngine ?? "").trim().toLowerCase();
  if (proto === "webrtc" && engine !== "hls" && engine !== "ll-hls" && engine !== "dash") {
    return { ms: null, notApplicable: true };
  }
  if (
    (proto === "srt" || proto === "rtmp" || proto === "http") &&
    engine !== "hls" &&
    engine !== "ll-hls" &&
    engine !== "dash"
  ) {
    return { ms: null, notApplicable: true };
  }
  if (engine === "whep") {
    return { ms: null, notApplicable: true };
  }
  if (engine === "ll-hls" || proto === "hls") {
    const duration = input.groupDurationMs != null ? input.groupDurationMs : LL_HLS_PART_MS;
    return { ms: round1(cleanMs(duration)), notApplicable: false };
  }
  if (engine === "hls") {
    const duration = input.groupDurationMs != null ? input.groupDurationMs : FAST_HLS_SEGMENT_MS;
    return { ms: round1(cleanMs(duration)), notApplicable: false };
  }
  if (proto === "moq" || engine === "moq") {
    if (input.groupDurationMs == null) {
      return { ms: null, notApplicable: false };
    }
    return { ms: round1(cleanMs(input.groupDurationMs)), notApplicable: false };
  }
  if (proto === "dash" || engine === "dash") {
    if (input.groupDurationMs == null) {
      return { ms: null, notApplicable: false };
    }
    return { ms: round1(cleanMs(input.groupDurationMs)), notApplicable: false };
  }
  if (input.groupDurationMs != null) {
    return { ms: round1(cleanMs(input.groupDurationMs)), notApplicable: false };
  }
  return { ms: null, notApplicable: false };
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
const STAGE_SHORT_NAMES: Record<LatencyComponentKey, string> = {
  latency_encode_ms: "encode",
  latency_segmentation_ms: "segmentation",
  latency_publish_ms: "publish",
  latency_network_ms: "network",
  latency_packager_ms: "packager",
  latency_player_buffer_ms: "player_buffer",
};

function namedUnmeasured(raw: unknown): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function stageIsUnmeasured(named: Set<string>, column: LatencyComponentKey): boolean {
  return named.has(column) || named.has(STAGE_SHORT_NAMES[column]);
}

/**
 * Rebuild player-side budget columns on a live upload sample after playback
 * is overlaid. The encoder loop writes residual=0 / player_buffer=0 because
 * it cannot see the glass; leaving those zeros in the comparison CSV made a
 * 10s RTMP/SRT/MoQ run look fully attributed (comparison 2026-08-23).
 */
function overlayBudgetInput(
  rec: Record<string, unknown>,
  named: Set<string>,
  namedNa: Set<string>,
  extras: Partial<LatencyBudgetInput>,
): LatencyBudgetInput {
  const netRtt = Number(rec.net_rtt_ms);
  const packager = Number(rec.latency_packager_ms);
  const publish = Number(rec.latency_publish_ms);
  const segmentation = Number(rec.latency_segmentation_ms);
  const protocol = String(rec.protocol ?? "");
  const engine = String(rec.engine ?? rec.playback_engine ?? "");
  const segmentationNa =
    namedNa.has("segmentation") || namedNa.has("latency_segmentation_ms");
  return {
    pipelineBaselineMs: Number(rec.latency_encode_ms) || 0,
    protocol,
    playbackEngine: engine,
    segmentationNotApplicable: segmentationNa,
    segmentationMs: segmentationNa
      ? null
      : stageIsUnmeasured(named, "latency_segmentation_ms")
        ? null
        : Number.isFinite(segmentation)
          ? segmentation
          : null,
    splitEncodeGop: false,
    publishTransitMs: stageIsUnmeasured(named, "latency_publish_ms")
      ? null
      : Number.isFinite(publish)
        ? publish
        : 0,
    netRttMs: stageIsUnmeasured(named, "latency_network_ms")
      ? null
      : Number.isFinite(netRtt) && netRtt > 0
        ? netRtt
        : null,
    packagerTransitMs: stageIsUnmeasured(named, "latency_packager_ms")
      ? null
      : Number.isFinite(packager)
        ? packager
        : 0,
    ...extras,
  };
}

/**
 * Rebuild player-side budget columns on a live upload sample after playback
 * is overlaid. The encoder loop writes residual=0 / player_buffer=0 because
 * it cannot see the glass; leaving those zeros in the comparison CSV made a
 * 10s RTMP/SRT/MoQ run look fully attributed (comparison 2026-08-23).
 *
 * Encode and segmentation are copied through — do not re-split GOP from an
 * already-final encode component.
 */
export function applyLatencyBudgetToSample<T extends object>(sample: T): T {
  const rec = sample as Record<string, unknown>;
  const named = namedUnmeasured(rec.latency_unmeasured);
  const namedNa = namedUnmeasured(rec.latency_not_applicable);
  const buffer = Number(rec.playback_buffer_sec);
  const e2e = Number(rec.e2e_latency_ms);
  const uploadOnly = String(rec.test_scope ?? "").trim().toLowerCase() === "upload";
  const hasPlayback =
    !uploadOnly &&
    ((Number.isFinite(e2e) && e2e > 0) || (Number.isFinite(buffer) && buffer > 0));
  const scopeRaw = String(rec.latency_e2e_scope ?? "");
  const e2eScope =
    scopeRaw === E2E_SCOPE_INGEST_TO_GLASS ||
    scopeRaw === E2E_SCOPE_CAPTURE_TO_GLASS ||
    scopeRaw === E2E_SCOPE_CAPTURE_TO_INGEST
      ? scopeRaw
      : e2eScopeFor(String(rec.protocol ?? ""), String(rec.engine ?? ""), String(rec.test_scope ?? ""));

  const draft = buildLatencyBudget(
    overlayBudgetInput(rec, named, namedNa, {
      playbackBufferSec: hasPlayback ? (Number.isFinite(buffer) ? buffer : 0) : null,
      e2eLatencyMs: Number.isFinite(e2e) ? e2e : 0,
      e2eScope,
    }),
  );
  const e2eMs =
    uploadOnly && !(Number.isFinite(e2e) && e2e > 0) ? draft.accountedMs : Number.isFinite(e2e) ? e2e : 0;
  const budget =
    uploadOnly && e2eMs !== (Number.isFinite(e2e) ? e2e : 0)
      ? buildLatencyBudget(
          overlayBudgetInput(rec, named, namedNa, {
            playbackBufferSec: null,
            e2eLatencyMs: e2eMs,
            e2eScope,
          }),
        )
      : draft;

  return {
    ...sample,
    ...(uploadOnly ? { e2e_latency_ms: e2eMs } : {}),
    latency_segmentation_ms: budget.segmentationMs,
    latency_player_buffer_ms: budget.playerBufferMs,
    latency_accounted_ms: budget.accountedMs,
    latency_residual_ms: budget.residualMs,
    latency_overcount_ms: budget.overcountMs,
    latency_unmeasured: budget.unmeasured.map((key) => STAGE_SHORT_NAMES[key]).join(","),
    latency_not_applicable: budget.notApplicable.map((key) => STAGE_SHORT_NAMES[key]).join(","),
    latency_e2e_scope: budget.e2eScope,
  };
}

export function e2eScopeFor(
  protocol: string | null | undefined,
  playbackEngine?: string | null,
  testScope?: string | null,
): E2eScope {
  if ((testScope ?? "").trim().toLowerCase() === "upload") {
    return E2E_SCOPE_CAPTURE_TO_INGEST;
  }
  const engine = (playbackEngine ?? "").trim().toLowerCase();
  if (engine === "monitor") {
    return E2E_SCOPE_CAPTURE_TO_INGEST;
  }
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
  const notApplicable: LatencyComponentKey[] = [];
  const resolved = resolveSegmentationMs({
    protocol: input.protocol,
    playbackEngine: input.playbackEngine,
    groupDurationMs: input.segmentationMs,
  });
  const segmentationNa = Boolean(input.segmentationNotApplicable) || resolved.notApplicable;
  const segmentationMs = segmentationNa ? 0 : resolved.ms == null ? 0 : resolved.ms;
  if (segmentationNa) {
    notApplicable.push("latency_segmentation_ms");
  } else if (resolved.ms == null) {
    unmeasured.push("latency_segmentation_ms");
  }
  if (input.publishTransitMs == null) unmeasured.push("latency_publish_ms");
  if (input.netRttMs == null) unmeasured.push("latency_network_ms");
  if (input.packagerTransitMs == null) unmeasured.push("latency_packager_ms");
  if (input.playbackBufferSec == null) unmeasured.push("latency_player_buffer_ms");

  const encodeMs = encodeLatencyMs({
    ...input,
    segmentationMs: segmentationNa ? 0 : resolved.ms,
    splitEncodeGop: Boolean(input.splitEncodeGop) && !segmentationNa && resolved.ms != null,
  });
  const publishMs = round1(cleanMs(input.publishTransitMs));
  const networkMs = networkLatencyMs(input.netRttMs);
  const packagerMs = round1(cleanMs(input.packagerTransitMs));
  const playerBufferMs = playerBufferLatencyMs(input.playbackBufferSec);
  const e2eMs = round1(cleanMs(input.e2eLatencyMs, E2E_MAX_MS));

  const skip = new Set<string>([
    ...(OUT_OF_SCOPE[e2eScope] ?? []),
    ...notApplicable,
  ]);
  const byKey: Record<LatencyComponentKey, number> = {
    latency_encode_ms: encodeMs,
    latency_segmentation_ms: segmentationMs,
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
    segmentationMs,
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
    notApplicable,
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
  const skip = new Set<string>([
    ...(OUT_OF_SCOPE[budget.e2eScope] ?? []),
    ...budget.notApplicable,
  ]);
  const unmeasured = new Set<string>(budget.unmeasured);
  const byKey: Record<LatencyComponentKey, number> = {
    latency_encode_ms: budget.encodeMs,
    latency_segmentation_ms: budget.segmentationMs,
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
