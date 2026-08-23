/**
 * Startup phase decomposition — browser mirror of src/startup_budget.py.
 *
 * `playback_ttff_ms` says a leg took 23 seconds to join, never *which*
 * component spent them. The RTMP startup win already banked (23s → 1501 ms)
 * came from reasoning about phases: the GOP was pinned to the HLS chunk
 * duration, so the first decodable frame could not arrive until a whole chunk
 * had been packaged. Nothing measured that. This family does.
 *
 * Two ordered chains, deliberately kept apart:
 *
 *   publisher  job start ──dns──> ──connect──> ──handshake──>
 *              ──publish_accept──> ──first_idr──> ──first_byte_ingest──> ingest
 *
 *   player     player attach ──player_request──> ──manifest──>
 *              ──first_media──> ──first_paint──> glass
 *
 * **They are two spans, not one.** Between "ingest has the first byte" and "an
 * operator opened the tile" sits dwell time belonging to neither pipeline, so a
 * joined total would be dominated by human reaction time. Each half reconciles
 * against its own measured total: the publisher chain against job-start →
 * first-byte-at-ingest, the player chain against `playback_ttff_ms`.
 *
 * Three honesty properties, inherited from `latencyBudget` because live legs
 * punished their absence there:
 *
 * - **Disagreement is signed.** `residualMs` is measured startup the phases
 *   cannot explain; `overcountMs` is phases exceeding the measured total. Only
 *   one can be non-zero per half, and a large residual is a signal rather than
 *   a failure.
 * - **A phase with no instrument is named, not zeroed.** `0` means "measured,
 *   and it was zero"; `null` means "nothing measures this here" and lands the
 *   phase in `unmeasured`.
 * - **A phase that does not exist is a third state.** SRT has no TCP connect —
 *   its caller handshake *is* the connect — and a raw MPEG-TS pull has no
 *   manifest. Calling those "unmeasured" would send an operator hunting for an
 *   instrument that cannot exist, so they land in `notApplicable`. Their time
 *   is not lost: the chain anchors the next phase to the last milestone that
 *   did happen, so an n/a phase's duration is attributed to the phase that
 *   genuinely contains it.
 *
 * Every helper is pure so it can be diffed against the Python and unit-tested
 * without a run. `scripts/unit-startup-budget.mjs` is what stops it drifting.
 */

/** Publisher chain: job start → first media confirmed at the ingest. */
export const STARTUP_PUBLISHER_COMPONENTS = [
  "startup_dns_ms",
  "startup_connect_ms",
  "startup_handshake_ms",
  "startup_publish_accept_ms",
  "startup_first_idr_ms",
  "startup_first_byte_ingest_ms",
] as const;

/** Player chain: player attach → first painted frame. */
export const STARTUP_PLAYER_COMPONENTS = [
  "startup_player_request_ms",
  "startup_manifest_ms",
  "startup_first_media_ms",
  "startup_first_paint_ms",
] as const;

export type StartupPublisherComponentKey = (typeof STARTUP_PUBLISHER_COMPONENTS)[number];
export type StartupPlayerComponentKey = (typeof STARTUP_PLAYER_COMPONENTS)[number];
export type StartupComponentKey = StartupPublisherComponentKey | StartupPlayerComponentKey;

export const STARTUP_COMPONENTS: readonly StartupComponentKey[] = [
  ...STARTUP_PUBLISHER_COMPONENTS,
  ...STARTUP_PLAYER_COMPONENTS,
];

/** Short stage names, as carried by `startup_unmeasured` / `startup_not_applicable`. */
export const PUBLISHER_STAGE_NAMES = [
  "dns",
  "connect",
  "handshake",
  "publish_accept",
  "first_idr",
  "first_byte_ingest",
] as const;
export const PLAYER_STAGE_NAMES = [
  "player_request",
  "manifest",
  "first_media",
  "first_paint",
] as const;
export const STAGE_NAMES: readonly string[] = [...PUBLISHER_STAGE_NAMES, ...PLAYER_STAGE_NAMES];

/** Reconciliation + annotation columns, in CSV order. */
export const STARTUP_DERIVED_COLUMNS = [
  "startup_publisher_accounted_ms",
  "startup_publisher_measured_ms",
  "startup_publisher_residual_ms",
  "startup_publisher_overcount_ms",
  "startup_player_accounted_ms",
  "startup_player_measured_ms",
  "startup_player_residual_ms",
  "startup_player_overcount_ms",
  "startup_unmeasured",
  "startup_not_applicable",
] as const;

export const STARTUP_COLUMNS: readonly string[] = [
  ...STARTUP_COMPONENTS,
  ...STARTUP_DERIVED_COLUMNS,
];

/**
 * The 18 columns that carry milliseconds. `startup_unmeasured` and
 * `startup_not_applicable` are stage-name lists, not series, so anything that
 * charts or averages must skip them.
 */
export const STARTUP_NUMERIC_COLUMNS: readonly string[] = STARTUP_COLUMNS.filter(
  (column) => column.endsWith("_ms"),
);

const STAGE_BY_COLUMN: Record<string, string> = Object.fromEntries(
  STARTUP_COMPONENTS.map((column, index) => [column, STAGE_NAMES[index]]),
);
const COLUMN_BY_STAGE: Record<string, string> = Object.fromEntries(
  STARTUP_COMPONENTS.map((column, index) => [STAGE_NAMES[index], column]),
);

export function stageForColumn(column: string): string {
  return STAGE_BY_COLUMN[column] ?? "";
}

export function columnForStage(stage: string): string {
  return COLUMN_BY_STAGE[stage.trim()] ?? "";
}

/** Chain order + display copy for the stacked view. Keep in sync with METRIC_DEFINITIONS. */
export interface StartupChainStep {
  key: StartupComponentKey;
  stage: string;
  label: string;
  span: string;
  color: string;
}

export const STARTUP_PUBLISHER_CHAIN: StartupChainStep[] = [
  {
    key: "startup_dns_ms",
    stage: "dns",
    label: "DNS",
    span: "job start → name resolved",
    color: "#38bdf8",
  },
  {
    key: "startup_connect_ms",
    stage: "connect",
    label: "Connect",
    span: "resolved → transport connected",
    color: "#22d3ee",
  },
  {
    key: "startup_handshake_ms",
    stage: "handshake",
    label: "Handshake",
    span: "connected → protocol session up",
    color: "#818cf8",
  },
  {
    key: "startup_publish_accept_ms",
    stage: "publish_accept",
    label: "Publish accept",
    span: "session up → ingest accepted the publish",
    color: "#a78bfa",
  },
  {
    key: "startup_first_idr_ms",
    stage: "first_idr",
    label: "First IDR",
    span: "accepted → encoder emitted its first frame",
    color: "#fbbf24",
  },
  {
    key: "startup_first_byte_ingest_ms",
    stage: "first_byte_ingest",
    label: "First byte at ingest",
    span: "first frame → ingest confirmed bytes",
    color: "#f59e0b",
  },
];

export const STARTUP_PLAYER_CHAIN: StartupChainStep[] = [
  {
    key: "startup_player_request_ms",
    stage: "player_request",
    label: "Player request",
    span: "player attach → request on the wire",
    color: "#38bdf8",
  },
  {
    key: "startup_manifest_ms",
    stage: "manifest",
    label: "Manifest / catalog",
    span: "request → manifest or catalog in hand",
    color: "#818cf8",
  },
  {
    key: "startup_first_media_ms",
    stage: "first_media",
    label: "First media",
    span: "manifest → first media bytes decoded",
    color: "#a78bfa",
  },
  {
    key: "startup_first_paint_ms",
    stage: "first_paint",
    label: "First paint",
    span: "first media → first frame on glass",
    color: "#4ade80",
  },
];

// ---------------------------------------------------------------------------
// Per-protocol normalization
// ---------------------------------------------------------------------------

/**
 * Phases that structurally do not exist on a protocol. Mirrors
 * `startup_budget._NOT_APPLICABLE`, and the unit test asserts it agrees with
 * the blank entries in PROTOCOL_PHASE_NOTES — two tables that disagree would
 * put a phase in both "no instrument" and "cannot exist".
 */
const NOT_APPLICABLE: Record<string, readonly StartupPublisherComponentKey[]> = {
  // SRT's caller handshake *is* its connect: there is no separate transport
  // connect over UDP to time. Attributing the whole exchange (including key
  // material) to `handshake` keeps it comparable with RTMP's handshake.
  srt: ["startup_connect_ms"],
  // QUIC folds transport connect and crypto into one handshake, and the
  // WebTransport CONNECT that follows is the session phase — so `connect` and
  // `handshake` both stay meaningful without inventing a TCP connect.
  moq: [],
  rtmp: [],
  // WHIP's 201 Created *is* the accept, reported on `publish_accept`, with the
  // HTTP request itself on `connect`.
  webrtc: [],
};

/**
 * Human-readable instrument per protocol/phase. An empty string means "no
 * instrument on this protocol" — the phase reports unmeasured, and this table
 * is where an operator finds out why. Verbatim from
 * `startup_budget.PROTOCOL_PHASE_NOTES`.
 */
export const PROTOCOL_PHASE_NOTES: Record<string, Record<string, string>> = {
  rtmp: {
    dns: "getaddrinfo() on the ingest host, timed in the preflight probe",
    connect: "TCP connect to the RTMP port (1935), timed in the preflight probe",
    handshake: "RTMP C0/C1/S0/S1/S2 exchange plus connect/createStream/publish",
    publish_accept: "ingest reports the input live (Zixi input ready / MediaMTX path ready)",
    first_idr: "encoder emits its first frame, which for H.264 is an IDR",
    first_byte_ingest: "ingest reports bytes received on the path",
  },
  srt: {
    dns: "getaddrinfo() on the ingest host, timed in the preflight probe",
    connect: "",
    handshake: "SRT caller handshake including key material exchange",
    publish_accept: "ingest reports the input live (Zixi input ready / MediaMTX path ready)",
    first_idr: "encoder emits its first frame, which for H.264 is an IDR",
    first_byte_ingest: "libsrt reports a non-zero send rate / ingest reports bytes received",
  },
  webrtc: {
    dns: "getaddrinfo() on the WHIP host, timed in the preflight probe",
    connect: "TCP/TLS connect to the WHIP endpoint (8889), timed in the preflight probe",
    handshake: "ICE establishment and DTLS setup",
    publish_accept: "WHIP POST offer → 201 Created with the answer SDP",
    first_idr: "encoder emits its first frame, which for H.264 is an IDR",
    first_byte_ingest: "MediaMTX reports bytes received (first RTP landed)",
  },
  moq: {
    dns: "getaddrinfo() on the relay host, timed in the preflight probe",
    connect: "QUIC handshake (transport + crypto in one exchange)",
    handshake: "WebTransport session established over the QUIC connection",
    publish_accept:
      "SETUP/ANNOUNCE accepted and the catalog published " +
      "('sender ready (namespace + catalog published)')",
    first_idr: "encoder emits its first frame, which for H.264 is an IDR",
    first_byte_ingest: "first object on the wire ('obj vide wall_dt_ms=')",
  },
};

/**
 * Keyed by playback engine, because the player is what measures these. An
 * empty string is again "no instrument" — and for an engine that has no such
 * phase at all (a raw MPEG-TS pull has no manifest) it is also what marks the
 * phase not-applicable, exactly as `build_player_startup` derives it.
 */
export const PLAYER_PHASE_NOTES: Record<string, Record<string, string>> = {
  hls: {
    player_request:
      "Resource Timing on the manifest request: fetchStart → requestStart (DNS + connect + TLS)",
    manifest: "Resource Timing on the manifest: requestStart → responseEnd",
    first_media: "first media segment response completes",
    first_paint: "first frame painted (currentTime advances past the session origin)",
  },
  "ll-hls": {
    player_request: "Resource Timing on the manifest request: fetchStart → requestStart",
    manifest: "Resource Timing on the manifest: requestStart → responseEnd",
    first_media: "first partial segment response completes",
    first_paint: "first frame painted (currentTime advances past the session origin)",
  },
  mpegts: {
    player_request: "Resource Timing on the TS request: fetchStart → requestStart",
    // A raw TS pull has no manifest at all: the first response *is* the media.
    // Reporting a 0 ms manifest would imply an instant fetch.
    manifest: "",
    first_media: "first bytes of the TS response (responseStart)",
    first_paint: "first frame painted (currentTime advances past the session origin)",
  },
  whep: {
    player_request: "Resource Timing on the WHEP POST: fetchStart → requestStart",
    manifest: "WHEP SDP exchange: POST offer → 201 answer (responseEnd)",
    first_media:
      "getStats(): ICE candidate-pair succeeded and DTLS connected, then first inbound-rtp bytes",
    first_paint: "first frame painted",
  },
  moq: {
    player_request: "playa: load() → WebTransport session connected",
    manifest: "playa: SETUP complete → catalog received (SUBSCRIBE, plus joining FETCH)",
    first_media: "playa: first group/object received, then decoder configured",
    first_paint: "playa: first frame rendered to the canvas",
  },
  dash: {
    player_request: "Resource Timing on the MPD request: fetchStart → requestStart",
    manifest: "Resource Timing on the MPD: requestStart → responseEnd",
    first_media: "first media segment response completes",
    first_paint: "first frame painted (currentTime advances past the session origin)",
  },
};

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Publisher phases that structurally do not exist on this protocol. */
export function notApplicableColumns(protocol: string | null | undefined): string[] {
  return [...(NOT_APPLICABLE[normalizeKey(protocol)] ?? [])];
}

/**
 * Player phases that do not exist on this engine, derived from a blank note —
 * the same derivation `build_player_startup` uses, so the two cannot disagree.
 * An unknown engine yields nothing: we do not know what it lacks.
 */
export function playerNotApplicableColumns(engine: string | null | undefined): string[] {
  const notes = PLAYER_PHASE_NOTES[normalizeKey(engine)];
  if (!notes) {
    return [];
  }
  return STARTUP_PLAYER_COMPONENTS.filter((column) => (notes[stageForColumn(column)] ?? "") === "");
}

/** What instrument backs a phase on a protocol; "" when there is none. */
export function phaseNote(protocol: string | null | undefined, stage: string): string {
  return PROTOCOL_PHASE_NOTES[normalizeKey(protocol)]?.[stage] ?? "";
}

export function playerPhaseNote(engine: string | null | undefined, stage: string): string {
  return PLAYER_PHASE_NOTES[normalizeKey(engine)]?.[stage] ?? "";
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/**
 * Sanity ceiling per phase. Startup phases are allowed to be far larger than a
 * steady-state latency component — the 23s RTMP baseline this family exists to
 * explain was a single phase — so the ceiling is generous. Above it the number
 * is a clock artifact, and it is dropped to unmeasured rather than clamped: a
 * clamped artifact charts exactly like a real 120s phase.
 */
export const PHASE_MAX_MS = 120_000;

/** A measured startup total may legitimately reach further still. */
export const TOTAL_MAX_MS = 180_000;

/**
 * Plausible non-negative milliseconds, or `null` for anything else — including
 * a blank CSV cell. Never 0, so a caller cannot turn "no reading" into
 * "measured zero" by passing a default through. Zero itself survives: a phase
 * really can complete inside the measurement resolution.
 */
export function cleanPhaseMs(
  value: number | string | null | undefined,
  ceiling: number = PHASE_MAX_MS,
): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return null;
    }
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > ceiling) {
    return null;
  }
  return round1(number);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Duration between two milestones (seconds), or `null` if either is missing.
 *
 * Deliberately strict. If the middle milestone of a chain is missing, the
 * honest answer is that *that* phase is unmeasured — not that its neighbour was
 * unusually long. Stretching a neighbour across the gap moves real time into
 * whichever phase happened to have an instrument, which is exactly the
 * misattribution this family exists to prevent.
 */
function phaseBetween(start: number | null, end: number | null | undefined): number | null {
  if (start == null || end == null) {
    return null;
  }
  return cleanPhaseMs((end - start) * 1000);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface StartupHalf {
  columns: readonly string[];
  /** Column → ms, with `null` meaning "no instrument". */
  phases: Record<string, number | null>;
  /** The total this half reconciles against, or null when it was not measured. */
  measuredMs: number | null;
  /** Columns with a reading. */
  accountedMs: number;
  /** Measured startup the phases cannot explain. Never negative. */
  residualMs: number;
  /** Phases in excess of the measured total. Never negative. */
  overcountMs: number;
  /** No reading, and not structurally absent — this is *why* residual is large. */
  unmeasured: string[];
  /** Structurally absent on this protocol/engine. Not the same as unmeasured. */
  notApplicable: string[];
}

export interface StartupBudget {
  publisher: StartupHalf;
  player: StartupHalf;
}

/** Stage names for a set of columns, in chain order. */
export function stageNamesFor(columns: Iterable<string>): string[] {
  const set = new Set(columns);
  return STARTUP_COMPONENTS.filter((column) => set.has(column)).map((column) =>
    stageForColumn(column),
  );
}

export function buildStartupHalf(
  columns: readonly string[],
  phases: Record<string, number | null>,
  measuredMs: number | null,
  notApplicable: Iterable<string> = [],
): StartupHalf {
  const absent = new Set(notApplicable);
  const unmeasured = columns.filter(
    (column) => !absent.has(column) && phases[column] == null,
  );
  const accountedMs = round1(
    columns.reduce((sum, column) => sum + (phases[column] ?? 0), 0),
  );
  // Two different facts, two columns. The residual is unattributed *time*, so
  // it cannot be negative; phases exceeding the measured total is a modelling
  // error with a different cause, and it only gets fixed if it is visible.
  const hasTotal = measuredMs != null && measuredMs > 0;
  return {
    columns,
    phases,
    measuredMs,
    accountedMs,
    residualMs: hasTotal ? round1(Math.max(0, measuredMs - accountedMs)) : 0,
    overcountMs: hasTotal ? round1(Math.max(0, accountedMs - measuredMs)) : 0,
    unmeasured,
    notApplicable: columns.filter((column) => absent.has(column)),
  };
}

export interface PublisherMilestones {
  protocol?: string | null;
  /** All in seconds, on one monotonic clock. */
  t0?: number | null;
  dnsDone?: number | null;
  connectDone?: number | null;
  handshakeDone?: number | null;
  publishAccepted?: number | null;
  firstIdr?: number | null;
  firstByteIngest?: number | null;
}

/**
 * Publisher chain from milestone timestamps.
 *
 * Phases marked not-applicable for the protocol are skipped when anchoring, so
 * their successor spans the whole exchange. SRT has no connect, so its
 * handshake is timed from `dnsDone` — which is correct, because on SRT
 * everything between name resolution and publish acceptance genuinely *is* the
 * caller handshake.
 */
export function buildPublisherStartup(input: PublisherMilestones): StartupHalf {
  const absent = new Set(notApplicableColumns(input.protocol));
  const milestones: Record<string, number | null | undefined> = {
    startup_dns_ms: input.dnsDone,
    startup_connect_ms: input.connectDone,
    startup_handshake_ms: input.handshakeDone,
    startup_publish_accept_ms: input.publishAccepted,
    startup_first_idr_ms: input.firstIdr,
    startup_first_byte_ingest_ms: input.firstByteIngest,
  };

  const phases: Record<string, number | null> = {};
  let anchor = input.t0 ?? null;
  // Whether `anchor` is the *immediately* preceding milestone. After a missing
  // milestone it is stale, and a duration measured from it would span two
  // phases. A not-applicable phase does not invalidate it: there was never a
  // milestone there to miss.
  let anchorFresh = input.t0 != null;
  for (const column of STARTUP_PUBLISHER_COMPONENTS) {
    if (absent.has(column)) {
      phases[column] = null;
      continue;
    }
    const end = milestones[column];
    phases[column] = anchorFresh ? phaseBetween(anchor, end) : null;
    if (end != null) {
      anchor = end;
      anchorFresh = true;
    } else {
      anchorFresh = false;
    }
  }

  const measured =
    input.t0 == null || input.firstByteIngest == null
      ? null
      : cleanPhaseMs((input.firstByteIngest - input.t0) * 1000, TOTAL_MAX_MS);
  return buildStartupHalf(STARTUP_PUBLISHER_COMPONENTS, phases, measured, absent);
}

export interface PlayerPhaseDurations {
  engine?: string | null;
  requestMs?: number | null;
  manifestMs?: number | null;
  firstMediaMs?: number | null;
  firstPaintMs?: number | null;
  /** `playback_ttff_ms` — the measured total this chain reconciles against. */
  ttffMs?: number | null;
}

/**
 * Player chain from phase durations the browser already computed.
 *
 * Unlike the publisher half this takes durations rather than milestones,
 * because that is the shape the browser can produce honestly: Resource Timing
 * hands back marks on one request and `getStats()` hands back transitions,
 * neither of which shares a clock origin with the job.
 */
export function buildPlayerStartup(input: PlayerPhaseDurations): StartupHalf {
  const absent = new Set(playerNotApplicableColumns(input.engine));
  const phases: Record<string, number | null> = {
    startup_player_request_ms: cleanPhaseMs(input.requestMs),
    startup_manifest_ms: cleanPhaseMs(input.manifestMs),
    startup_first_media_ms: cleanPhaseMs(input.firstMediaMs),
    startup_first_paint_ms: cleanPhaseMs(input.firstPaintMs),
  };
  for (const column of absent) {
    phases[column] = null;
  }
  return buildStartupHalf(
    STARTUP_PLAYER_COMPONENTS,
    phases,
    cleanPhaseMs(input.ttffMs, TOTAL_MAX_MS),
    absent,
  );
}

/** Both halves. See the module comment for why they stay apart. */
export function buildStartupBudget(
  publisher: PublisherMilestones,
  player: PlayerPhaseDurations,
): StartupBudget {
  return {
    publisher: buildPublisherStartup(publisher),
    player: buildPlayerStartup(player),
  };
}

/** A CSV row or a live sample: cells may be strings, numbers, or absent. */
export type StartupColumnSource = Record<string, string | number | null | undefined>;

function stageListToColumns(value: string): string[] {
  return value
    .split(",")
    .map((stage) => columnForStage(stage))
    .filter((column) => column !== "");
}

/**
 * Rebuild both halves from already-reported columns (a CSV row or a live
 * sample), which is the shape the UI actually receives.
 *
 * A blank cell stays `null` — the whole point of the column set is that blank
 * and `0.0` are different facts, so this must never coerce one into the other.
 * The reported `startup_not_applicable` annotation wins when present (even
 * empty, which is a positive statement that nothing is structurally absent);
 * only when the column is missing entirely do we fall back to deriving n/a
 * from the protocol and engine tables.
 */
export function startupBudgetFromColumns(
  source: StartupColumnSource,
  options: { protocol?: string | null; engine?: string | null } = {},
): StartupBudget {
  const reportedNa = source.startup_not_applicable;
  const absent =
    reportedNa == null
      ? new Set<string>([
          ...notApplicableColumns(options.protocol),
          ...playerNotApplicableColumns(options.engine),
        ])
      : new Set<string>(stageListToColumns(String(reportedNa)));

  const readPhases = (columns: readonly string[]): Record<string, number | null> =>
    Object.fromEntries(columns.map((column) => [column, cleanPhaseMs(source[column])]));

  return {
    publisher: buildStartupHalf(
      STARTUP_PUBLISHER_COMPONENTS,
      readPhases(STARTUP_PUBLISHER_COMPONENTS),
      cleanPhaseMs(source.startup_publisher_measured_ms, TOTAL_MAX_MS),
      [...absent].filter((column) =>
        (STARTUP_PUBLISHER_COMPONENTS as readonly string[]).includes(column),
      ),
    ),
    player: buildStartupHalf(
      STARTUP_PLAYER_COMPONENTS,
      readPhases(STARTUP_PLAYER_COMPONENTS),
      cleanPhaseMs(source.startup_player_measured_ms, TOTAL_MAX_MS),
      [...absent].filter((column) =>
        (STARTUP_PLAYER_COMPONENTS as readonly string[]).includes(column),
      ),
    ),
  };
}

export interface StartupShare {
  key: string;
  stage: string;
  label: string;
  ms: number;
  pct: number;
  /** No instrument here. Renders distinctly from a measured 0. */
  unmeasured?: boolean;
  /** Structurally absent. Nobody should hunt for an instrument. */
  notApplicable?: boolean;
  /** The trailing reconciliation segment. */
  reconciliation?: boolean;
}

/**
 * Share of the measured startup total each phase explains, for the stacked
 * view. Returns null when the half has no measured total — an unweighted stack
 * would imply a total we never measured, the same reason
 * `latencyBudgetShares()` refuses.
 *
 * Unmeasured and not-applicable phases are still returned, at 0 ms and
 * flagged, because the caller has to draw them as *distinct from* a measured
 * zero. `overcount` is stacked instead of `residual` when the phases exceed
 * the measurement, so the chart never silently hides it.
 */
export function startupBudgetShares(half: StartupHalf): StartupShare[] | null {
  if (half.measuredMs == null || half.measuredMs <= 0) {
    return null;
  }
  const unmeasured = new Set(half.unmeasured);
  const absent = new Set(half.notApplicable);
  const chain = [...STARTUP_PUBLISHER_CHAIN, ...STARTUP_PLAYER_CHAIN].filter((step) =>
    half.columns.includes(step.key),
  );
  const parts: Array<Omit<StartupShare, "pct">> = chain.map((step) => ({
    key: step.key,
    stage: step.stage,
    label: step.label,
    ms: half.phases[step.key] ?? 0,
    unmeasured: unmeasured.has(step.key),
    notApplicable: absent.has(step.key),
  }));
  parts.push(
    half.overcountMs > 0
      ? {
          key: "overcount",
          stage: "overcount",
          label: "Over-attributed",
          ms: half.overcountMs,
          reconciliation: true,
        }
      : {
          key: "residual",
          stage: "residual",
          label: "Unattributed",
          ms: half.residualMs,
          reconciliation: true,
        },
  );
  const total = parts.reduce((sum, part) => sum + part.ms, 0) || half.measuredMs;
  return parts.map((part) => ({ ...part, pct: Math.round((part.ms / total) * 1000) / 10 }));
}

/** True when a half has anything worth drawing at all. */
export function startupHalfHasData(half: StartupHalf): boolean {
  return (
    half.accountedMs > 0 ||
    (half.measuredMs != null && half.measuredMs > 0) ||
    half.columns.some((column) => half.phases[column] != null)
  );
}
