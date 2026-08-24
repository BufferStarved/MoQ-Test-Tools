interface PlayerHudProps {
  visible: boolean;
  ttffMs?: number | null;
  latencyMs?: number | null;
  latencyScope?: string | null;
  /** Ingest-to-glass + encode; shown only on WHEP as a capture-class hint. */
  latencyCaptureHintMs?: number | null;
  /** CMAF group / object cadence — never labelled ingest. */
  segmentationMs?: number | null;
  ttffBest?: boolean;
  latencyBest?: boolean;
  ttffDeltaMs?: number | null;
  latencyDeltaMs?: number | null;
}

function finitePositive(value?: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function HudFigure({
  label,
  valueMs,
  best,
  deltaMs,
  hint,
}: {
  label: string;
  valueMs: number;
  best?: boolean;
  deltaMs?: number | null;
  hint?: string | null;
}) {
  return (
    <span className={`player-hud-item${best ? " player-hud-best" : ""}`}>
      <span className="player-hud-label">{label}</span>
      <span className="metric-figure">{Math.round(valueMs)} ms</span>
      {deltaMs != null && deltaMs > 0 ? (
        <span className="player-hud-delta">+{deltaMs}</span>
      ) : null}
      {hint ? <span className="player-hud-hint">{hint}</span> : null}
    </span>
  );
}

/** Glass-to-glass glance from existing playback sample fields. Overlay only. */
export function PlayerHud({
  visible,
  ttffMs,
  latencyMs,
  latencyScope = null,
  latencyCaptureHintMs = null,
  segmentationMs = null,
  ttffBest = false,
  latencyBest = false,
  ttffDeltaMs = null,
  latencyDeltaMs = null,
}: PlayerHudProps) {
  const showTtff = finitePositive(ttffMs);
  const showLatency = finitePositive(latencyMs);
  const showSegmentation = finitePositive(segmentationMs);
  if (!visible || (!showTtff && !showLatency && !showSegmentation)) {
    return null;
  }
  const latencyLabel =
    latencyScope === "ingest_to_glass" || latencyScope === "capture_to_ingest"
      ? "Latency · ingest path"
      : "Latency · glass";
  const hint =
    latencyScope === "ingest_to_glass" && finitePositive(latencyCaptureHintMs)
      ? `≈ ${Math.round(latencyCaptureHintMs)} capture`
      : null;
  return (
    <div className="player-hud" aria-hidden="true">
      {showTtff ? (
        <HudFigure label="TTFF" valueMs={ttffMs} best={ttffBest} deltaMs={ttffDeltaMs} />
      ) : null}
      {showLatency ? (
        <HudFigure
          label={latencyLabel}
          valueMs={latencyMs}
          best={latencyBest}
          deltaMs={latencyDeltaMs}
          hint={hint}
        />
      ) : null}
      {showSegmentation ? (
        <HudFigure label="CMAF group" valueMs={segmentationMs} />
      ) : null}
    </div>
  );
}
