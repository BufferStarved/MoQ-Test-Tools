import { MetricLabel } from "./MetricLabel";
import type { ResultSummary } from "./types";

interface SessionMetricsProps {
  streams: ResultSummary[];
  labels?: string[];
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

function downloadUrl(filename: string, kind: "csv" | "json"): string {
  return `/api/results/${encodeURIComponent(filename)}/download?kind=${kind}`;
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

export function SessionMetrics({ streams, labels }: SessionMetricsProps) {
  if (streams.length === 0) {
    return (
      <p className="muted">
        Run a comparison on the Benchmark tab. When it finishes, this tab shows a scorecard for that
        session and download links for JSON/CSV.
      </p>
    );
  }

  return (
    <div className="session-metrics">
      <div className="session-metrics-header">
        <div>
          <h3>Last comparison · {streams.length} streams</h3>
          <p className="hint">
            Post-run scorecard for the session that just finished. Download raw samples (CSV) or the
            summary JSON per stream.
          </p>
        </div>
      </div>

      <div className="session-download-grid">
        {streams.map((result, index) => (
          <div key={result.filename} className="session-download-card">
            <div>
              <strong>{streamLabel(result, index, labels)}</strong>
              <p className="hint endpoint-copy">{result.endpoint}</p>
            </div>
            <div className="download-actions">
              <a className="csv-download" href={downloadUrl(result.filename, "csv")} download>
                CSV
              </a>
              <a className="csv-download" href={downloadUrl(result.filename, "json")} download>
                JSON
              </a>
            </div>
          </div>
        ))}
      </div>

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
