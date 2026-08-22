interface PlayerHudProps {
  visible: boolean;
  ttffMs?: number | null;
  latencyMs?: number | null;
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
}: {
  label: string;
  valueMs: number;
  best?: boolean;
  deltaMs?: number | null;
}) {
  return (
    <span className={`player-hud-item${best ? " player-hud-best" : ""}`}>
      <span className="player-hud-label">{label}</span>
      <span className="metric-figure">{Math.round(valueMs)} ms</span>
      {deltaMs != null && deltaMs > 0 ? (
        <span className="player-hud-delta">+{deltaMs}</span>
      ) : null}
    </span>
  );
}

/** Glass-to-glass glance from existing playback sample fields. Overlay only. */
export function PlayerHud({
  visible,
  ttffMs,
  latencyMs,
  ttffBest = false,
  latencyBest = false,
  ttffDeltaMs = null,
  latencyDeltaMs = null,
}: PlayerHudProps) {
  const showTtff = finitePositive(ttffMs);
  const showLatency = finitePositive(latencyMs);
  if (!visible || (!showTtff && !showLatency)) {
    return null;
  }
  return (
    <div className="player-hud" aria-hidden="true">
      {showTtff ? (
        <HudFigure label="TTFF" valueMs={ttffMs} best={ttffBest} deltaMs={ttffDeltaMs} />
      ) : null}
      {showLatency ? (
        <HudFigure
          label="Latency"
          valueMs={latencyMs}
          best={latencyBest}
          deltaMs={latencyDeltaMs}
        />
      ) : null}
    </div>
  );
}
