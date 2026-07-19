import { liveGlanceMetrics, type ComparisonVerdict } from "./comparisonVerdict";
import { protocolColor, protocolLabel } from "./protocolTheme";
import type { UploadJob, UploadSample } from "./types";

interface SummaryLeg {
  id: string;
  label: string;
  protocol: string;
  job: UploadJob;
  latestSample: UploadSample | null;
}

interface TopSummaryStripProps {
  legs: SummaryLeg[];
  /** Post-run decision highlights when session summaries are available. */
  verdict?: ComparisonVerdict | null;
  /** True while any leg is still encoding / publishing. */
  running?: boolean;
}

function statusTone(job: UploadJob): "ok" | "warn" | "bad" | "idle" {
  if (job.status === "failed") {
    return "bad";
  }
  if (job.status === "completed") {
    return "ok";
  }
  if (job.status === "running") {
    return job.preview_ready === false ? "warn" : "ok";
  }
  return "idle";
}

function statusLabel(job: UploadJob): string {
  if (job.status === "running" && job.preview_ready === false) {
    return "buffering";
  }
  return job.status;
}

export function TopSummaryStrip({ legs, verdict = null, running = false }: TopSummaryStripProps) {
  if (legs.length === 0 && !verdict) {
    return null;
  }

  return (
    <div className="top-summary-strip" role="status">
      {verdict && !running && (
        <div className="decision-board">
          <div className="decision-board-headline">
            <span className="decision-board-kicker">Verdict</span>
            <p>{verdict.headline}</p>
          </div>
          <div className="decision-board-highlights">
            {verdict.highlights.map((item) => (
              <div
                key={item.label}
                className="decision-highlight"
                style={{ "--chip-color": protocolColor(item.protocol) } as never}
              >
                <span className="decision-highlight-label">{item.label}</span>
                <strong>{item.winner}</strong>
                <span className="decision-highlight-value">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {legs.length > 0 && (
        <div className="top-summary-legs">
          {running && <span className="top-summary-kicker">Live</span>}
          {legs.map((leg, index) => {
            const tone = statusTone(leg.job);
            const color = protocolColor(leg.protocol, index);
            const glances = liveGlanceMetrics(leg.latestSample);
            return (
              <div
                key={leg.id}
                className={`top-summary-chip tone-${tone}`}
                style={{ "--chip-color": color } as never}
              >
                <span className="top-summary-dot" />
                <span className="top-summary-protocol">{protocolLabel(leg.protocol)}</span>
                <span className="top-summary-status">{statusLabel(leg.job)}</span>
                {glances.map((glance) => (
                  <span key={glance.label} className="top-summary-metric">
                    {glance.label} {glance.value}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
