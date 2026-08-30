import { comparisonLegStatusLabel, comparisonLegTone } from "./comparisonReplay";
import { liveGlanceMetrics, type ComparisonVerdict } from "./comparisonVerdict";
import { assignStreamColors, protocolColor, protocolLabel } from "./protocolTheme";
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

function statusTone(leg: SummaryLeg): "ok" | "warn" | "bad" | "idle" {
  return comparisonLegTone({
    protocol: leg.protocol,
    jobStatus: leg.job.status,
    previewReady: leg.job.preview_ready,
    framesRendered: Number(leg.latestSample?.playback_frames_rendered ?? 0),
    bitrateBps: Number(leg.latestSample?.playback_bitrate_bps ?? 0),
  });
}

function statusLabel(leg: SummaryLeg): string {
  return comparisonLegStatusLabel({
    protocol: leg.protocol,
    jobStatus: leg.job.status,
    previewReady: leg.job.preview_ready,
    framesRendered: Number(leg.latestSample?.playback_frames_rendered ?? 0),
    bitrateBps: Number(leg.latestSample?.playback_bitrate_bps ?? 0),
  });
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
          {assignStreamColors(
            legs.map((item) => ({
              protocol: item.protocol,
              endpoint: item.job.endpoint_url,
            })),
          ).map((color, index) => {
            const leg = legs[index];
            const tone = statusTone(leg);
            const glances = liveGlanceMetrics(leg.latestSample);
            return (
              <div
                key={leg.id}
                className={`top-summary-chip tone-${tone}`}
                style={{ "--chip-color": color } as never}
              >
                <span className="top-summary-dot" />
                <span className="top-summary-protocol">{protocolLabel(leg.protocol)}</span>
                <span className="top-summary-status">{statusLabel(leg)}</span>
                {glances.map((glance) => (
                  <span key={glance.label} className="top-summary-metric">
                    {glance.label} {glance.value}
                  </span>
                ))}
                {Boolean(leg.job.compute_vmaf_encoder || leg.job.compute_vmaf_on_ingest) &&
                leg.job.encoder_vmaf_score != null &&
                Number.isFinite(leg.job.encoder_vmaf_score) ? (
                  <span className="top-summary-metric">
                    VMAF {leg.job.encoder_vmaf_score.toFixed(1)}
                  </span>
                ) : Boolean(leg.job.compute_vmaf_encoder || leg.job.compute_vmaf_on_ingest) &&
                  leg.job.vmaf_score != null &&
                  Number.isFinite(leg.job.vmaf_score) ? (
                  <span className="top-summary-metric">VMAF {leg.job.vmaf_score.toFixed(1)}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
