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
import { ChartSectionNote } from "./ChartSectionNote";
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
  const clientGroup = chartGroupById("client");
  const ingestGroup = chartGroupById("ingest");
  const mediaHealthGroup = chartGroupById("media_health");
  const playbackGroup = chartGroupById("playback");
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
            <ChartSectionNote
              title="Encode / publish (this host)"
              items={[
                "Bitrate and frame rate come from ffmpeg while publishing.",
                "Send rate is outbound publish throughput.",
                "Client memory is ffmpeg / publisher RSS on this machine.",
                "Client network jitter is RTT variation on the publisher side of the path.",
                "Encode lag, speed, and FPS stability come from ffmpeg progress while publishing.",
                "VMAF / PSNR / SSIM score the encoder capture when quality metrics are enabled.",
              ]}
            />
            <MetricChart
              title="Bitrate"
              metricKey="encoded_bitrate_kbps"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "encoded_bitrate_kbps")}
            />
            <MetricChart
              title="Frame rate"
              metricKey="fps"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "fps")}
            />
            <MetricChart
              title="Send rate"
              metricKey="net_send_mbps"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "net_send_mbps")}
              keepZeroSeries
            />
            <MetricChart
              title="Client memory"
              metricKey="memory_mb"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "memory_mb")}
              keepZeroSeries
            />
            <MetricChart
              title="Client network jitter"
              metricKey="net_jitter_ms"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "net_jitter_ms")}
              keepZeroSeries
            />
            {(hasData(points, "encode_lag_ms") ||
              hasData(points, "fps_stability") ||
              hasData(points, "speed")) && (
              <MetricChart
                title="Encode lag / speed / FPS stability"
                metricKey="encode_lag_ms"
                data={points}
                series={encodeGroup.series.filter(
                  (series) =>
                    series.key === "encode_lag_ms" ||
                    series.key === "fps_stability" ||
                    series.key === "speed",
                )}
              />
            )}
            <MetricChart
              title="VMAF"
              metricKey="vmaf_score_encoder"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "vmaf_score_encoder")}

              yDomain={[0, 100]}
              keepZeroSeries
            />
            <MetricChart
              title="PSNR"
              metricKey="psnr_db_encoder"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "psnr_db_encoder")}
              keepZeroSeries
            />
            <MetricChart
              title="SSIM"
              metricKey="ssim_encoder"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "ssim_encoder")}

              yDomain={[0, 1]}
              keepZeroSeries
            />
          </>
        )}

        {currentGroup.id === "client" && clientGroup && (
          <MetricChart title="Client (publisher host)" metricKey="cpu_percent" data={points} series={clientGroup.series} />
        )}

        {currentGroup.id === "ingest" && ingestGroup && (
          <>
            <ChartSectionNote
              title="Ingest path"
              items={[
                "Shared across MoQ / SRT / RTMP: ingest-host CPU & memory, plus path loss% and retransmit%.",
                "SRT RTT: libsrt / Zixi receiver.",
                "RTMP RTT: Zixi receiver when available; otherwise a TCP probe to the RTMP host:port.",
                "MoQ RTT: QUIC qlog when available; otherwise a TCP probe to the relay (same host as WebTransport).",
                "Protocol panels below are native counters (MoQ relay Δ, SRT / Zixi recovery).",
              ]}
            />
            <AvailabilityNote metricKey="net_rtt_ms" protocol={resolvedProtocol} />
            <MetricChart
              title="RTT"
              metricKey="net_rtt_ms"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "net_rtt_ms")}
            />
            <MetricChart
              title="Server network jitter"
              metricKey="net_jitter_ms"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "net_jitter_ms")}
            />
            <MetricChart
              title="Ingest host"
              metricKey="server_cpu_percent"
              data={points}
              series={ingestGroup.series.filter(
                (series) =>
                  series.key === "server_cpu_percent" ||
                  series.key === "server_memory_percent" ||
                  series.key === "server_disk_percent",
              )}
            />
            <MetricChart
              title="Path loss %"
              metricKey="net_loss_pct"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "net_loss_pct")}
              keepZeroSeries
            />
            <MetricChart
              title="Retransmit %"
              metricKey="net_retrans_pct"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "net_retrans_pct")}
              keepZeroSeries
            />
            {isMoq && (
              <>
                <MetricChart
                  title="Receive loss"
                  metricKey="quic_packets_lost"
                  data={points}
                  series={ingestGroup.series.filter((series) => series.key === "quic_packets_lost")}
                  keepZeroSeries
                />
                {hasData(points, "quic_cwnd_bytes") && (
                  <MetricChart
                    title="QUIC congestion window"
                    metricKey="quic_cwnd_bytes"
                    data={points}
                    series={ingestGroup.series.filter((series) => series.key === "quic_cwnd_bytes")}
                  />
                )}
              </>
            )}
            {isSrtOrRtmp && (
              <MetricChart
                title="FEC extra"
                metricKey="pkt_fec_extra"
                data={points}
                series={ingestGroup.series.filter((series) => series.key === "pkt_fec_extra")}
                keepZeroSeries
              />
            )}
            <MetricChart
              title="VMAF (ingest)"
              metricKey="vmaf_score_ingest"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "vmaf_score_ingest")}

              yDomain={[0, 100]}
              keepZeroSeries
            />
            <MetricChart
              title="PSNR (ingest)"
              metricKey="psnr_db_ingest"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "psnr_db_ingest")}
              keepZeroSeries
            />
            <MetricChart
              title="SSIM (ingest)"
              metricKey="ssim_ingest"
              data={points}
              series={ingestGroup.series.filter((series) => series.key === "ssim_ingest")}

              yDomain={[0, 1]}
              keepZeroSeries
            />
          </>
        )}

        {currentGroup.id === "media_health" && mediaHealthGroup && (
          <>
            <AvailabilityNote metricKey="ts_continuity_counter_errors" protocol={resolvedProtocol} />
            <AvailabilityNote metricKey="cmaf_seq_gap_count" protocol={resolvedProtocol} />
            <ChartSectionNote
              title="Media container integrity"
              items={[
                "Measures timeline and container health — not network transport.",
                "MPEG-TS (SRT/RTMP): Zixi TR101 continuity-counter errors.",
                "MoQ CMAF: fragment sequence gaps, decode-time gaps, and parse errors.",
              ]}
            />
            <MetricChart
              title="Media Health"
              metricKey="ts_continuity_counter_errors"
              data={points}
              series={mediaHealthGroup.series.filter((series) => hasData(points, series.key))}
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
              keepZeroSeries
            />
            {hasData(points, "playback_rebuffer_sec") && (
              <MetricChart
                title="Rebuffer time"
                metricKey="playback_rebuffer_sec"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "playback_rebuffer_sec")}
                keepZeroSeries
              />
            )}
            {hasData(points, "playback_buffer_sec") && (
              <MetricChart
                title="Buffer size"
                metricKey="playback_buffer_sec"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "playback_buffer_sec")}
              />
            )}
            {hasData(points, "playback_video_time_sec") && (
              <MetricChart
                title="Video playback time"
                metricKey="playback_video_time_sec"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "playback_video_time_sec")}
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
