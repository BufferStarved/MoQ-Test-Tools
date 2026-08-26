import { useMemo, type CSSProperties } from "react";

import { ChartSectionNote } from "./ChartSectionNote";
import { metricDefinition } from "./metricDefinitions";
import {
  STARTUP_PLAYER_CHAIN,
  STARTUP_PUBLISHER_CHAIN,
  type StartupChainStep,
  type StartupColumnSource,
  type StartupHalf,
  phaseNote,
  playerPhaseNote,
  startupBudgetFromColumns,
  startupBudgetShares,
  startupHalfHasData,
} from "./startupBudget.ts";
import type { ResultSummary, UploadSample } from "./types";

interface StartupBreakdownProps {
  result?: ResultSummary | null;
  liveSamples?: UploadSample[];
  protocol?: string;
  /** Player that produced the player half (whep, ll-hls, moq…). */
  playbackEngine?: string;
}

/**
 * Startup, attributed to phases instead of reported as one join number.
 *
 * A one-shot event is drawn as a stacked horizontal bar rather than a time
 * series: there is nothing to plot against time, and a bar is the shape that
 * answers "which phase spent the 23 seconds". The two chains get two bars and
 * are never concatenated — the dwell between "ingest has the first byte" and
 * "an operator opened the tile" belongs to neither pipeline.
 *
 * The three states are drawn as three different things on purpose. A measured
 * value is a solid segment; a phase with no instrument is a hatched marker; a
 * phase that cannot exist on this path is an outlined marker. Collapsing any
 * two of those into "0 ms" is the failure this whole family exists to avoid.
 */
export function StartupBreakdown({
  result,
  liveSamples = [],
  protocol,
  playbackEngine,
}: StartupBreakdownProps) {
  const source = useMemo(() => startupSource(result, liveSamples), [result, liveSamples]);
  const resolvedProtocol = result?.protocol ?? protocol ?? "";
  const resolvedEngine = playbackEngine ?? result?.summary_extra?.playback_engine ?? "";

  const budget = useMemo(
    () =>
      source
        ? startupBudgetFromColumns(source, {
            protocol: resolvedProtocol,
            engine: resolvedEngine,
          })
        : null,
    [source, resolvedProtocol, resolvedEngine],
  );

  if (!budget) {
    return (
      <div className="charts-empty muted">
        No startup phases reported for this leg. Startup is a one-shot measurement taken while the
        job connects and while the player joins — a run with no preflight probe and no player
        attach has nothing to decompose.
      </div>
    );
  }

  return (
    <>
      <ChartSectionNote
        title="Startup breakdown (two separate spans)"
        items={[
          "Publisher chain: job start → first media confirmed at the ingest.",
          "Player chain: player attach → first painted frame (playback_ttff_ms).",
          "The two are never summed: the dwell between them is operator reaction time, not pipeline time.",
          "Solid = measured. Hatched = no instrument here. Outlined = this phase does not exist on this path.",
          "A trailing segment shows what the phases could not explain (or over-explained).",
        ]}
      />
      <StartupChainBar
        title="Publisher chain"
        span="job start → first media confirmed at the ingest"
        totalLabel="Measured (job start → ingest)"
        half={budget.publisher}
        chain={STARTUP_PUBLISHER_CHAIN}
        accountedKey="startup_publisher_accounted_ms"
        measuredKey="startup_publisher_measured_ms"
        residualKey="startup_publisher_residual_ms"
        overcountKey="startup_publisher_overcount_ms"
        instrument={(stage) => phaseNote(resolvedProtocol, stage)}
        context={resolvedProtocol ? resolvedProtocol.toUpperCase() : "unknown protocol"}
      />
      <StartupChainBar
        title="Player chain"
        span="player attach → first painted frame"
        totalLabel="Measured TTFF"
        half={budget.player}
        chain={STARTUP_PLAYER_CHAIN}
        accountedKey="startup_player_accounted_ms"
        measuredKey="startup_player_measured_ms"
        residualKey="startup_player_residual_ms"
        overcountKey="startup_player_overcount_ms"
        instrument={(stage) => playerPhaseNote(resolvedEngine, stage)}
        context={resolvedEngine ? `${resolvedEngine} player` : "unknown player engine"}
      />
    </>
  );
}

/**
 * Why a phase is absent rather than zero. Read from the contract's tables so
 * the copy cannot drift from the code that decides the state.
 */
const NOT_APPLICABLE_REASONS: Record<string, string> = {
  connect:
    "SRT's caller handshake is its connect — there is no separate transport connect over UDP to time. Its cost is inside the handshake phase, not missing.",
  manifest:
    "A raw MPEG-TS pull has no manifest at all: the first response is the media. Its cost is inside the first-media phase.",
};

const NOT_APPLICABLE_FALLBACK =
  "This phase does not exist on this path. Its time is attributed to the phase that genuinely contains it, so nothing is lost.";

interface StartupChainBarProps {
  title: string;
  span: string;
  totalLabel: string;
  half: StartupHalf;
  chain: StartupChainStep[];
  accountedKey: string;
  measuredKey: string;
  residualKey: string;
  overcountKey: string;
  instrument: (stage: string) => string;
  context: string;
}

/** Fixed width for a zero-duration marker, so an absent phase is still visible. */
const MARKER_WIDTH = "22px";

function StartupChainBar({
  title,
  span,
  totalLabel,
  half,
  chain,
  accountedKey,
  measuredKey,
  residualKey,
  overcountKey,
  instrument,
  context,
}: StartupChainBarProps) {
  const shares = startupBudgetShares(half);
  const unmeasured = new Set(half.unmeasured);
  const notApplicable = new Set(half.notApplicable);
  const reconciliationKey = half.overcountMs > 0 ? overcountKey : residualKey;

  if (!startupHalfHasData(half)) {
    return (
      <section className="startup-chain">
        <h4>{title}</h4>
        <p className="hint chart-availability-note">
          Nothing measured on this half ({context}). Every phase is blank — which is not the same
          as zero, and is why there is no bar to draw.
        </p>
      </section>
    );
  }

  return (
    <section className="startup-chain" style={{ marginBottom: "1.25rem" }}>
      <h4 style={{ marginBottom: "0.15rem" }}>{title}</h4>
      <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>
        {span} · {context}
      </p>

      {shares ? (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            width: "100%",
            height: "26px",
            borderRadius: "4px",
            overflow: "hidden",
            background: "rgba(148, 163, 184, 0.12)",
          }}
        >
          {shares.map((part) => {
            const step = chain.find((item) => item.key === part.key);
            const absent = part.notApplicable ?? false;
            const missing = part.unmeasured ?? false;
            // A measured zero has no width and no marker: it is honestly
            // nothing. Absent and unmeasured phases get a fixed marker,
            // because "we did not measure this" is information.
            if (part.ms <= 0 && !absent && !missing) {
              return null;
            }
            const color = part.reconciliation
              ? half.overcountMs > 0
                ? "#fb7185"
                : "#f87171"
              : (step?.color ?? "#64748b");
            const style: CSSProperties = {
              flexBasis: 0,
              flexGrow: part.ms > 0 ? part.ms : 0,
              minWidth: part.ms > 0 ? "2px" : MARKER_WIDTH,
              width: part.ms > 0 ? undefined : MARKER_WIDTH,
              flexShrink: 0,
              background: absent
                ? "transparent"
                : missing
                  ? `repeating-linear-gradient(45deg, ${color}55 0 4px, transparent 4px 8px)`
                  : color,
              border: absent
                ? "1px dashed rgba(148, 163, 184, 0.8)"
                : missing
                  ? `1px solid ${color}aa`
                  : "none",
              boxSizing: "border-box",
            };
            return (
              <div
                key={part.key}
                style={style}
                title={segmentTooltip(part.label, part.ms, part.pct, absent, missing)}
              />
            );
          })}
        </div>
      ) : (
        <p className="hint chart-availability-note">
          No measured total for this half, so the phases are listed but not stacked — a stack
          without a measured total would imply a total nothing measured.
        </p>
      )}

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(9rem, auto) minmax(7rem, auto) 1fr",
          gap: "0.15rem 0.75rem",
          margin: "0.6rem 0 0",
          fontSize: "0.8rem",
        }}
      >
        {chain.map((step) => {
          const value = half.phases[step.key] ?? null;
          const absent = notApplicable.has(step.key);
          const missing = unmeasured.has(step.key);
          const note = instrument(step.stage);
          return (
            <PhaseRow
              key={step.key}
              step={step}
              value={value}
              absent={absent}
              missing={missing}
              note={note}
            />
          );
        })}
        <PhaseTotalRow label={totalLabel} metricKey={measuredKey} value={half.measuredMs} />
        <PhaseTotalRow
          label="Accounted (phases summed)"
          metricKey={accountedKey}
          value={half.accountedMs}
        />
        <PhaseTotalRow
          label={half.overcountMs > 0 ? "Over-attributed" : "Unattributed"}
          value={half.overcountMs > 0 ? half.overcountMs : half.residualMs}
          hint={
            half.overcountMs > 0
              ? "Phases exceed the measured total: two of them share a span somewhere. A modelling bug, shown rather than clamped away."
              : half.residualMs > 0
                ? "Measured startup the phases cannot explain. Large is a useful signal, not a failure — read the blank phases above first."
                : "The phases explain the whole measured total."
          }
          metricKey={reconciliationKey}
        />
      </dl>
    </section>
  );
}

function PhaseRow({
  step,
  value,
  absent,
  missing,
  note,
}: {
  step: StartupChainStep;
  value: number | null;
  absent: boolean;
  missing: boolean;
  note: string;
}) {
  const definition = metricDefinition(step.key);
  const state = absent ? (
    <span className="muted" title={NOT_APPLICABLE_REASONS[step.stage] ?? NOT_APPLICABLE_FALLBACK}>
      n/a
    </span>
  ) : missing ? (
    <span className="muted" title="No instrument on this path — blank, which is not zero.">
      unmeasured
    </span>
  ) : (
    <span>{formatMs(value ?? 0)}</span>
  );
  const explanation = absent
    ? (NOT_APPLICABLE_REASONS[step.stage] ?? NOT_APPLICABLE_FALLBACK)
    : missing
      ? note
        ? `Nothing reported it on this leg. The instrument that should: ${note}`
        : "No instrument on this path yet."
      : note || step.span;
  return (
    <>
      <dt title={definition?.description ?? step.span}>
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: "0.6rem",
            height: "0.6rem",
            marginRight: "0.4rem",
            borderRadius: "2px",
            background: absent ? "transparent" : step.color,
            border: absent ? "1px dashed rgba(148, 163, 184, 0.8)" : "none",
            opacity: missing ? 0.45 : 1,
          }}
        />
        {step.label}
      </dt>
      <dd style={{ margin: 0 }}>{state}</dd>
      <dd className="muted" style={{ margin: 0 }}>
        {explanation}
      </dd>
    </>
  );
}

function PhaseTotalRow({
  label,
  value,
  hint,
  metricKey,
}: {
  label: string;
  value: number | null;
  hint?: string;
  metricKey?: string;
}) {
  const definition = metricKey ? metricDefinition(metricKey) : undefined;
  return (
    <>
      <dt style={{ fontWeight: 600 }} title={definition?.description}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>
        {value == null ? <span className="muted">not measured</span> : formatMs(value)}
      </dd>
      <dd className="muted" style={{ margin: 0 }}>
        {hint ?? ""}
      </dd>
    </>
  );
}

function segmentTooltip(
  label: string,
  ms: number,
  pct: number,
  absent: boolean,
  missing: boolean,
): string {
  if (absent) {
    return `${label}: not applicable on this path`;
  }
  if (missing) {
    return `${label}: unmeasured (blank, not zero)`;
  }
  return `${label}: ${formatMs(ms)} (${pct.toFixed(1)}%)`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

/**
 * The row (or sample) that actually carries the startup measurement.
 *
 * Startup is one-shot but the CSV repeats the columns on every row, and the
 * player half only lands once the browser attaches — several samples in. The
 * last row with any startup evidence is therefore the most complete one.
 * Rows are read raw rather than through chart points on purpose: a chart point
 * is all numbers, so it cannot carry "blank".
 */
function startupSource(
  result: ResultSummary | null | undefined,
  liveSamples: UploadSample[],
): StartupColumnSource | null {
  const rows = result?.rows ?? [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (hasStartupEvidence(rows[index])) {
      return rows[index] as StartupColumnSource;
    }
  }
  for (let index = liveSamples.length - 1; index >= 0; index -= 1) {
    const candidate = liveSamples[index] as unknown as StartupColumnSource;
    if (hasStartupEvidence(candidate)) {
      return candidate;
    }
  }
  return null;
}

const EVIDENCE_KEYS = [
  "startup_publisher_measured_ms",
  "startup_player_measured_ms",
  "startup_publisher_accounted_ms",
  "startup_player_accounted_ms",
  "startup_dns_ms",
  "startup_player_request_ms",
  "startup_unmeasured",
  "startup_not_applicable",
];

function hasStartupEvidence(source: StartupColumnSource | undefined): boolean {
  if (!source) {
    return false;
  }
  return EVIDENCE_KEYS.some((key) => {
    const value = source[key];
    if (value == null) {
      return false;
    }
    return typeof value === "number" ? Number.isFinite(value) : value.trim() !== "";
  });
}
