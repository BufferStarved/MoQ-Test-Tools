import { useMemo } from "react";
import { downloadCombinedCsv, downloadCombinedJsonFromSummaries } from "./combinedDownload";
import { buildComparisonVerdict } from "./comparisonVerdict";
import { ComparisonCharts } from "./ComparisonCharts";
import { resultToSavedStream, savedStreamsToLegs } from "./chartData";
import { MetricLabel } from "./MetricLabel";
import { PipelineConfigDetails } from "./PipelineConfigDetails";
import { buildSessionPipelineSections } from "./pipelineConfig";
import { protocolColor } from "./protocolTheme";
import type { ResultSummary } from "./types";

interface SessionMetricsProps {
  streams: ResultSummary[];
  labels?: string[];
  /** When true, this is a session loaded from history (not the just-finished run). */
  fromHistory?: boolean;
}

function formatBytes(value?: number): string {
  if (value == null || value <= 0) {
    return "—";
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)} GB`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} MB`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function formatMs(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return "—";
  }
  return `${Math.round(value)} ms`;
}

function formatNum(value?: number | null, digits = 1, suffix = ""): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(digits)}${suffix}`;
}

function streamLabel(result: ResultSummary, index: number, labels?: string[]): string {
  if (labels?.[index]) {
    return labels[index];
  }
  if (result.summary_extra?.stream_label) {
    return result.summary_extra.stream_label;
  }
  return `Stream ${index + 1} (${result.protocol.toUpperCase()})`;
}

function healthTone(count?: number | null): "ok" | "warn" | "na" {
  if (count == null) {
    return "na";
  }
  return count > 0 ? "warn" : "ok";
}

function ScoreCell({
  metricKey,
  label,
  value,
  tone = "na",
}: {
  metricKey: string;
  label: string;
  value: string;
  tone?: "ok" | "warn" | "na";
}) {
  return (
    <div className={`score-cell tone-${tone}`}>
      <MetricLabel metricKey={metricKey} label={label} />
      <strong>{value}</strong>
    </div>
  );
}

export function SessionMetrics({ streams, labels, fromHistory = false }: SessionMetricsProps) {
  const chartLegs = useMemo(() => {
    const saved = streams.map((result, index) => {
      const stream = resultToSavedStream(result, index);
      return {
        ...stream,
        label: streamLabel(result, index, labels),
      };
    });
    return savedStreamsToLegs(saved);
  }, [streams, labels]);

  const verdict = useMemo(() => buildComparisonVerdict(streams, labels), [streams, labels]);
  const pipelineSections = useMemo(() => buildSessionPipelineSections(streams), [streams]);

  if (streams.length === 0) {
    return (
      <div className="results-empty">
        <p className="muted">
          Run a comparison on the Benchmark tab to answer which protocol and host path fit your
          latency, quality, and delivery goals.
        </p>
        <p className="hint">
          When a run finishes — or you pick a past session — this tab shows a verdict, scorecard,
          charts, and downloadable CSV/JSON.
        </p>
      </div>
    );
  }

  const title = fromHistory
    ? `Selected session · ${streams.length} streams`
    : `Latest comparison · ${streams.length} streams`;

  return (
    <div className="session-metrics">
      {verdict && (
        <div className="results-verdict">
          <span className="decision-board-kicker">Verdict</span>
          <p className="results-verdict-headline">{verdict.headline}</p>
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

      <div className="session-metrics-header">
        <div>
          <h3>{title}</h3>
          <p className="hint">
            Scorecard for latency, throughput, quality, and host health. Download raw samples (CSV)
            or the summary (JSON) for all streams in one file.
          </p>
        </div>
        <div className="download-actions">
          <button
            type="button"
            className="csv-download"
            onClick={() =>
              void downloadCombinedCsv(
                streams.map((result, index) => ({
                  label: streamLabel(result, index, labels),
                  filename: result.filename,
                })),
                "comparison.csv",
              )
            }
          >
            Download CSV
          </button>
          <button
            type="button"
            className="csv-download"
            onClick={() =>
              downloadCombinedJsonFromSummaries(
                streams.map((result, index) => ({
                  label: streamLabel(result, index, labels),
                  summary: result as unknown as Record<string, unknown>,
                })),
                "comparison.json",
              )
            }
          >
            Download JSON
          </button>
        </div>
      </div>

      {pipelineSections.length > 0 && (
        <PipelineConfigDetails
          sections={pipelineSections}
          buttonLabel="Session pipeline config"
          className="session-pipeline-config"
        />
      )}

      {chartLegs.length > 0 && (
        <section className="scorecard-section session-charts-section">
          <h4>Session charts</h4>
          <p className="hint">
            Same Encode/Publish, Ingest, Media Health, and Playback charts as the Benchmark tab,
            built from the saved CSV for this session.
          </p>
          <ComparisonCharts legs={chartLegs} minLegs={1} />
        </section>
      )}

      <section className="scorecard-section">
        <h4>Latency & join</h4>
        <div className="scorecard-grid" style={{ gridTemplateColumns: `repeat(${streams.length}, minmax(0, 1fr))` }}>
          {streams.map((result, index) => {
            const avg = result.averages;
            return (
              <div key={`lat-${result.filename}`} className="scorecard-column">
                <p className="scorecard-column-title">{streamLabel(result, index, labels)}</p>
                <ScoreCell
                  metricKey="e2e_latency_ms"
                  label="E2E avg"
                  value={formatMs(avg.e2e_latency_ms)}
                />
                <ScoreCell
                  metricKey="e2e_latency_ms"
                  label="E2E max"
                  value={formatMs(avg.e2e_latency_max_ms)}
                />
                <ScoreCell
                  metricKey="playback_ttff_ms"
                  label="TTFF"
                  value={formatMs(avg.playback_ttff_ms)}
                />
                <ScoreCell
                  metricKey="playback_stall_count"
                  label="Stalls"
                  value={String(avg.playback_stall_count ?? "—")}
                  tone={healthTone(avg.playback_stall_count)}
                />
                <ScoreCell
                  metricKey="playback_buffer_sec"
                  label="Buffer avg"
                  value={
                    avg.playback_buffer_sec != null
                      ? `${avg.playback_buffer_sec.toFixed(2)} s`
                      : "—"
                  }
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className="scorecard-section">
        <h4>Throughput</h4>
        <div className="scorecard-grid" style={{ gridTemplateColumns: `repeat(${streams.length}, minmax(0, 1fr))` }}>
          {streams.map((result, index) => {
            const tp = result.throughput;
            return (
              <div key={`tp-${result.filename}`} className="scorecard-column">
                <p className="scorecard-column-title">{streamLabel(result, index, labels)}</p>
                <ScoreCell
                  metricKey="total_bytes_sent"
                  label="Bytes sent"
                  value={formatBytes(tp?.total_bytes_sent)}
                />
                <ScoreCell
                  metricKey="total_bytes_received"
                  label="Bytes received"
                  value={formatBytes(tp?.total_bytes_received)}
                />
                <ScoreCell
                  metricKey="peak_bandwidth_sent_mbps"
                  label="Peak send"
                  value={
                    tp?.peak_bandwidth_sent_mbps
                      ? `${tp.peak_bandwidth_sent_mbps.toFixed(2)} Mbps`
                      : "—"
                  }
                />
                <ScoreCell
                  metricKey="peak_bandwidth_received_mbps"
                  label="Peak receive"
                  value={
                    tp?.peak_bandwidth_received_mbps
                      ? `${tp.peak_bandwidth_received_mbps.toFixed(2)} Mbps`
                      : "—"
                  }
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className="scorecard-section">
        <h4>Video quality</h4>
        <div className="scorecard-grid" style={{ gridTemplateColumns: `repeat(${streams.length}, minmax(0, 1fr))` }}>
          {streams.map((result, index) => {
            const encoder = result.quality?.encoder;
            const ingest = result.quality?.ingest;
            const avg = result.averages;
            return (
              <div key={`q-${result.filename}`} className="scorecard-column">
                <p className="scorecard-column-title">{streamLabel(result, index, labels)}</p>
                <ScoreCell
                  metricKey="vmaf_score"
                  label="VMAF (encoder)"
                  value={formatNum(encoder?.vmaf_score ?? null, 1)}
                />
                <ScoreCell
                  metricKey="vmaf_score"
                  label="VMAF (ingest)"
                  value={formatNum(ingest?.vmaf_score ?? avg.vmaf_score ?? null, 1)}
                />
                <ScoreCell
                  metricKey="psnr_db"
                  label="PSNR (encoder)"
                  value={encoder?.psnr_db != null ? `${encoder.psnr_db.toFixed(1)} dB` : "—"}
                />
                <ScoreCell
                  metricKey="psnr_db"
                  label="PSNR (ingest)"
                  value={
                    ingest?.psnr_db != null
                      ? `${ingest.psnr_db.toFixed(1)} dB`
                      : avg.psnr_db != null
                        ? `${avg.psnr_db.toFixed(1)} dB`
                        : "—"
                  }
                />
                <ScoreCell
                  metricKey="ssim"
                  label="SSIM (encoder)"
                  value={formatNum(encoder?.ssim ?? null, 3)}
                />
                <ScoreCell
                  metricKey="ssim"
                  label="SSIM (ingest)"
                  value={formatNum(ingest?.ssim ?? avg.ssim ?? null, 3)}
                />
                {(encoder?.status === "failed" || encoder?.error) && (
                  <p className="hint scorecard-quality-error">
                    Encoder quality: {encoder.error ?? encoder.status}
                  </p>
                )}
                {(ingest?.status === "failed" || ingest?.error) && (
                  <p className="hint scorecard-quality-error">
                    Ingest quality: {ingest.error ?? ingest.status}
                  </p>
                )}
                {!encoder && !ingest && (
                  <p className="hint">
                    No VMAF/PSNR/SSIM in this session — enable the checkbox with the color-bar
                    asset (not webcam) before Start.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="scorecard-section">
        <h4>Media health (end state)</h4>
        <div className="scorecard-grid" style={{ gridTemplateColumns: `repeat(${streams.length}, minmax(0, 1fr))` }}>
          {streams.map((result, index) => {
            const avg = result.averages;
            const isMoq = result.protocol === "moq";
            return (
              <div key={`mh-${result.filename}`} className="scorecard-column">
                <p className="scorecard-column-title">{streamLabel(result, index, labels)}</p>
                {!isMoq && (
                  <ScoreCell
                    metricKey="ts_continuity_counter_errors"
                    label="TS continuity errors"
                    value={String(avg.ts_continuity_counter_errors ?? "—")}
                    tone={healthTone(avg.ts_continuity_counter_errors)}
                  />
                )}
                {isMoq && (
                  <>
                    <ScoreCell
                      metricKey="cmaf_seq_gap_count"
                      label="CMAF sequence gaps"
                      value={String(avg.cmaf_seq_gap_count ?? "—")}
                      tone={healthTone(avg.cmaf_seq_gap_count)}
                    />
                    <ScoreCell
                      metricKey="cmaf_tfdt_gap_count"
                      label="CMAF decode-time gaps"
                      value={String(avg.cmaf_tfdt_gap_count ?? "—")}
                      tone={healthTone(avg.cmaf_tfdt_gap_count)}
                    />
                    <ScoreCell
                      metricKey="cmaf_parse_errors"
                      label="CMAF parse errors"
                      value={String(avg.cmaf_parse_errors ?? "—")}
                      tone={healthTone(avg.cmaf_parse_errors)}
                    />
                  </>
                )}
                <ScoreCell
                  metricKey="playback_frames_dropped"
                  label="Frames dropped"
                  value={String(avg.playback_frames_dropped ?? "—")}
                  tone={healthTone(avg.playback_frames_dropped)}
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className="scorecard-section">
        <h4>Encode health</h4>
        <div className="scorecard-grid" style={{ gridTemplateColumns: `repeat(${streams.length}, minmax(0, 1fr))` }}>
          {streams.map((result, index) => {
            const avg = result.averages;
            return (
              <div key={`enc-${result.filename}`} className="scorecard-column">
                <p className="scorecard-column-title">{streamLabel(result, index, labels)}</p>
                <ScoreCell
                  metricKey="encode_lag_ms"
                  label="Avg encode lag"
                  value={formatMs(avg.encode_lag_ms)}
                />
                <ScoreCell
                  metricKey="fps_stability"
                  label="FPS stability"
                  value={formatNum(avg.fps_stability ?? null, 4)}
                />
                <ScoreCell
                  metricKey="speed"
                  label="Avg speed"
                  value={avg.speed != null ? `${avg.speed.toFixed(2)}x` : "—"}
                />
                <ScoreCell
                  metricKey="fps"
                  label="Avg FPS"
                  value={formatNum(avg.fps ?? null, 1)}
                />
                <ScoreCell
                  metricKey="encoded_bitrate_kbps"
                  label="Avg bitrate"
                  value={
                    avg.encoded_bitrate_kbps != null
                      ? `${avg.encoded_bitrate_kbps.toFixed(0)} kbps`
                      : "—"
                  }
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
