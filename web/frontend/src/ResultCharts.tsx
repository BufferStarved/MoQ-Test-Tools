import { useEffect, useMemo, useState } from "react";
import {
  applyQualityScores,
  chartGroupById,
  resultToChartPoints,
  samplesToChartPoints,
  visibleGroups,
  type ChartPoint,
} from "./chartData";
import { MetricChart } from "./MetricChart";
import { metricUnavailableMessage, metricSupportedForProtocol } from "./metricModel";
import type { ResultSummary, UploadSample } from "./types";

interface ResultChartsProps {
  result?: ResultSummary | null;
  liveSamples?: UploadSample[];
  protocol?: string;
  vmafScore?: number | null;
  psnrDb?: number | null;
  ssim?: number | null;
}

function AvailabilityNote({ metricKey, protocol }: { metricKey: string; protocol: string }) {
  if (metricSupportedForProtocol(metricKey, protocol)) {
    return null;
  }
  return <p className="hint chart-availability-note">{metricUnavailableMessage(metricKey, protocol)}</p>;
}

export function ResultCharts({
  result,
  liveSamples = [],
  protocol,
  vmafScore,
  psnrDb,
  ssim,
}: ResultChartsProps) {
  const points = useMemo<ChartPoint[]>(() => {
    if (result) {
      return resultToChartPoints(result);
    }
    const livePoints = samplesToChartPoints(liveSamples);
    return applyQualityScores(livePoints, { vmafScore, psnrDb, ssim });
  }, [result, liveSamples, vmafScore, psnrDb, ssim]);

  const resolvedProtocol = result?.protocol ?? protocol ?? "srt";
  const groups = useMemo(() => visibleGroups(points, resolvedProtocol), [points, resolvedProtocol]);
  const [activeGroup, setActiveGroup] = useState(groups[0]?.id ?? "encode");

  useEffect(() => {
    if (!groups.some((group) => group.id === activeGroup)) {
      setActiveGroup(groups[0]?.id ?? "encode");
    }
  }, [groups, activeGroup]);

  const currentGroup = groups.find((group) => group.id === activeGroup) ?? groups[0];
  const encodeGroup = chartGroupById("encode");
  const transportGroup = chartGroupById("transport");
  const clientGroup = chartGroupById("client");
  const ingestGroup = chartGroupById("ingest");
  const mediaHealthGroup = chartGroupById("media_health");
  const playbackGroup = chartGroupById("playback");
  const qualityGroup = chartGroupById("video_quality");
  const isMoq = resolvedProtocol === "moq";
  const isSrtOrRtmp = resolvedProtocol === "srt" || resolvedProtocol === "rtmp";

  if (points.length === 0) {
    return (
      <div className="charts-empty muted">
        No telemetry samples yet. Run a benchmark to see live charts, or select a saved result.
      </div>
    );
  }

  if (!currentGroup) {
    return <div className="charts-empty muted">No plottable metrics in this result.</div>;
  }

  return (
    <div className="charts-panel">
      <div className="charts-toolbar">
        <div className="chart-group-tabs">
          {groups.map((group) => (
            <button
              key={group.id}
              className={group.id === currentGroup.id ? "active" : ""}
              onClick={() => setActiveGroup(group.id)}
            >
              {group.title}
            </button>
          ))}
        </div>
        <span className="charts-meta">{points.length} samples</span>
      </div>

      <div className="charts-grid">
        {currentGroup.id === "encode" && encodeGroup && (
          <>
            <MetricChart
              title="Bitrate & frame rate"
              metricKey="encoded_bitrate_kbps"
              data={points}
              series={encodeGroup.series.filter(
                (series) => series.key === "encoded_bitrate_kbps" || series.key === "fps",
              )}
              height={260}
            />
            <MetricChart
              title="Speed & lag"
              metricKey="encode_lag_ms"
              data={points}
              series={encodeGroup.series.filter(
                (series) =>
                  series.key === "speed" ||
                  series.key === "fps_stability" ||
                  series.key === "encode_lag_ms",
              )}
              height={260}
            />
          </>
        )}

        {currentGroup.id === "transport" && transportGroup && (
          <>
            <AvailabilityNote metricKey="net_rtt_ms" protocol={resolvedProtocol} />
            <MetricChart
              title="RTT & jitter (normalized)"
              metricKey="net_rtt_ms"
              data={points}
              series={transportGroup.series.filter(
                (series) => series.key === "net_rtt_ms" || series.key === "net_jitter_ms",
              )}
              height={260}
            />
            <MetricChart
              title="Send & receive rate"
              metricKey="net_send_mbps"
              data={points}
              series={transportGroup.series.filter(
                (series) => series.key === "net_send_mbps" || series.key === "net_recv_mbps",
              )}
              height={260}
            />
            {(hasData(points, "net_loss_pct") || hasData(points, "net_retrans_pct")) && (
              <MetricChart
                title="Loss & retransmit %"
                metricKey="net_loss_pct"
                data={points}
                series={transportGroup.series.filter(
                  (series) => series.key === "net_loss_pct" || series.key === "net_retrans_pct",
                )}
                height={220}
              />
            )}
          </>
        )}

        {currentGroup.id === "client" && clientGroup && (
          <MetricChart title="Client (publisher host)" metricKey="cpu_percent" data={points} series={clientGroup.series} height={260} />
        )}

        {currentGroup.id === "ingest" && ingestGroup && (
          <>
            <p className="hint chart-availability-note">
              Normalized ingest: host CPU/memory/disk and path loss/retransmit %. Protocol detail
              below depends on the publish path (MoQ relay or SRT/Zixi).
            </p>
            <MetricChart
              title="Ingest host (normalized)"
              metricKey="server_cpu_percent"
              data={points}
              series={ingestGroup.series.filter(
                (series) =>
                  series.key === "server_cpu_percent" ||
                  series.key === "server_memory_percent" ||
                  series.key === "server_disk_percent",
              )}
              height={260}
            />
            {(hasData(points, "net_loss_pct") || hasData(points, "net_retrans_pct")) && (
              <MetricChart
                title="Path recovery (normalized)"
                metricKey="net_loss_pct"
                data={points}
                series={ingestGroup.series.filter(
                  (series) => series.key === "net_loss_pct" || series.key === "net_retrans_pct",
                )}
                height={220}
                keepZeroSeries
              />
            )}
            {isMoq && (
              <>
                <AvailabilityNote metricKey="moqx_subscribe_success" protocol={resolvedProtocol} />
                <p className="hint chart-availability-note">
                  MoQ relay counters are job-window deltas (not absolute since relay restart).
                </p>
                <MetricChart
                  title="MoQ relay subscribe (Δ)"
                  metricKey="moqx_subscribe_success"
                  data={points}
                  series={ingestGroup.series.filter(
                    (series) =>
                      series.key === "moqx_subscribe_success" ||
                      series.key === "moqx_subscribe_error",
                  )}
                  height={260}
                  keepZeroSeries
                />
                <MetricChart
                  title="MoQ relay publish (Δ)"
                  metricKey="moqx_publish_received"
                  data={points}
                  series={ingestGroup.series.filter(
                    (series) =>
                      series.key === "moqx_publish_namespace_success" ||
                      series.key === "moqx_publish_received",
                  )}
                  height={260}
                  keepZeroSeries
                />
                {hasData(points, "quic_cwnd_bytes") && (
                  <MetricChart
                    title="QUIC congestion window"
                    metricKey="quic_cwnd_bytes"
                    data={points}
                    series={ingestGroup.series.filter((series) => series.key === "quic_cwnd_bytes")}
                    height={220}
                  />
                )}
              </>
            )}
            {isSrtOrRtmp && (
              <>
                <p className="hint chart-availability-note">
                  Libsrt recovery counters from the SRT sender. Flat zeros mean a clean path.
                </p>
                <MetricChart
                  title="SRT / Zixi recovery"
                  metricKey="pkt_retrans"
                  data={points}
                  series={ingestGroup.series.filter(
                    (series) =>
                      series.key === "pkt_retrans" ||
                      series.key === "pkt_fec_extra" ||
                      series.key === "pkt_snd_loss",
                  )}
                  height={260}
                  keepZeroSeries
                />
              </>
            )}
          </>
        )}

        {currentGroup.id === "media_health" && mediaHealthGroup && (
          <>
            <AvailabilityNote metricKey="ts_continuity_counter_errors" protocol={resolvedProtocol} />
            <AvailabilityNote metricKey="cmaf_seq_gap_count" protocol={resolvedProtocol} />
            <p className="hint chart-availability-note">
              Media Health is container/timeline integrity — not transport.
            </p>
            <MetricChart
              title="Media Health"
              metricKey="ts_continuity_counter_errors"
              data={points}
              series={mediaHealthGroup.series.filter((series) => hasData(points, series.key))}
              height={260}
            />
          </>
        )}

        {currentGroup.id === "playback" && playbackGroup && (
          <>
            {hasData(points, "e2e_latency_ms") && (
              <MetricChart
                title="E2E latency (estimated)"
                metricKey="e2e_latency_ms"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "e2e_latency_ms")}
                height={260}
              />
            )}
            <MetricChart
              title="Playback health"
              metricKey="playback_stall_count"
              data={points}
              series={playbackGroup.series.filter(
                (series) =>
                  series.key === "playback_ttff_ms" ||
                  series.key === "playback_stall_count" ||
                  series.key === "playback_error_count" ||
                  series.key === "playback_frames_rendered",
              )}
              height={260}
              keepZeroSeries
            />
            {hasData(points, "playback_buffer_sec") && (
              <MetricChart
                title="Buffer duration"
                metricKey="playback_buffer_sec"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "playback_buffer_sec")}
                height={220}
              />
            )}
            {hasData(points, "playback_video_time_sec") && (
              <MetricChart
                title="Video playback time"
                metricKey="playback_video_time_sec"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "playback_video_time_sec")}
                height={220}
              />
            )}
          </>
        )}

        {currentGroup.id === "video_quality" && qualityGroup && (
          <>
            {hasData(points, "vmaf_score") && (
              <MetricChart
                title="VMAF score"
                metricKey="vmaf_score"
                data={points}
                series={qualityGroup.series.filter((series) => series.key === "vmaf_score")}
                height={260}
                yDomain={[0, 100]}
              />
            )}
            {hasData(points, "psnr_db") && (
              <MetricChart
                title="PSNR"
                metricKey="psnr_db"
                data={points}
                series={qualityGroup.series.filter((series) => series.key === "psnr_db")}
                height={260}
              />
            )}
            {hasData(points, "ssim") && (
              <MetricChart
                title="SSIM"
                metricKey="ssim"
                data={points}
                series={qualityGroup.series.filter((series) => series.key === "ssim")}
                height={260}
                yDomain={[0, 1]}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function hasData(points: ChartPoint[], key: string): boolean {
  return points.some((point) => point[key] > 0);
}
