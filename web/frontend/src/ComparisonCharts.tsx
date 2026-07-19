import { useEffect, useMemo, useState } from "react";
import {
  chartGroupById,
  comparisonHasMetric,
  comparisonHasMetricPresent,
  comparisonSeries,
  comparisonVisibleGroups,
  buildComparisonPoints,
  type ComparisonLegData,
} from "./chartData";
import { MetricChart } from "./MetricChart";
import { ChartSectionNote } from "./ChartSectionNote";
import { metricUnavailableMessage, metricSupportedForProtocol } from "./metricModel";
import { protocolColor } from "./protocolTheme";

interface ComparisonChartsProps {
  legs: ComparisonLegData[];
  /** Minimum legs with data before charts render (default 2 for live compare). */
  minLegs?: number;
}

function ProtocolAvailabilityNote({
  metricKey,
  legs,
}: {
  metricKey: string;
  legs: ComparisonLegData[];
}) {
  const unsupported = legs.filter((leg) => !metricSupportedForProtocol(metricKey, leg.protocol));
  if (unsupported.length === 0) {
    return null;
  }
  return (
    <p className="hint chart-availability-note">
      {unsupported
        .map((leg) => metricUnavailableMessage(metricKey, leg.protocol))
        .filter((value, index, all) => all.indexOf(value) === index)
        .join(" · ")}
    </p>
  );
}

export function ComparisonCharts({ legs, minLegs = 2 }: ComparisonChartsProps) {
  const activeLegs = legs.filter(
    (leg) => leg.samples.length > 0 || (leg.result?.rows?.length ?? 0) > 0,
  );
  const points = useMemo(() => buildComparisonPoints(activeLegs), [activeLegs]);
  const groups = useMemo(
    () => comparisonVisibleGroups(points, activeLegs),
    [points, activeLegs],
  );
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
  const hasMoqLeg = activeLegs.some((leg) => leg.protocol === "moq");
  const hasSrtOrRtmpLeg = activeLegs.some(
    (leg) => leg.protocol === "srt" || leg.protocol === "rtmp",
  );

  if (activeLegs.length < minLegs) {
    return (
      <div className="charts-empty muted">Waiting for uploads to produce telemetry...</div>
    );
  }

  if (points.length === 0 || !currentGroup) {
    return <div className="charts-empty muted">No comparison data yet.</div>;
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
        <span className="charts-meta">
          {points.length} seconds · {activeLegs.length} legs
        </span>
      </div>

      <div className="comparison-legend">
        {activeLegs.map((leg, index) => (
          <span key={leg.id} className="comparison-legend-item">
            <span
              className="comparison-swatch"
              style={{ background: protocolColor(leg.protocol, index) }}
            />
            {leg.label}
          </span>
        ))}
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
              series={comparisonSeries(activeLegs, "encoded_bitrate_kbps", "kbps")}
              height={280}
            />
            <MetricChart
              title="Frame rate"
              metricKey="fps"
              data={points}
              series={comparisonSeries(activeLegs, "fps", "fps")}
              height={280}
            />
            <MetricChart
              title="Send rate"
              metricKey="net_send_mbps"
              data={points}
              series={comparisonSeries(activeLegs, "net_send_mbps", "Mbps")}
              height={280}
              keepZeroSeries
            />
            <MetricChart
              title="Client memory"
              metricKey="memory_mb"
              data={points}
              series={comparisonSeries(activeLegs, "memory_mb", "MB")}
              height={260}
              keepZeroSeries
            />
            <MetricChart
              title="Client network jitter"
              metricKey="net_jitter_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_jitter_ms", "ms")}
              height={260}
              keepZeroSeries
            />
            {comparisonHasMetric(points, "encode_lag_ms", activeLegs.length) && (
              <MetricChart
                title="Encode lag"
                metricKey="encode_lag_ms"
                data={points}
                series={comparisonSeries(activeLegs, "encode_lag_ms", "ms")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "fps_stability", activeLegs.length) && (
              <MetricChart
                title="FPS stability"
                metricKey="fps_stability"
                data={points}
                series={comparisonSeries(activeLegs, "fps_stability", "cv")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "speed", activeLegs.length) && (
              <MetricChart
                title="Speed"
                metricKey="speed"
                data={points}
                series={comparisonSeries(activeLegs, "speed", "x")}
                height={260}
              />
            )}
            <MetricChart
              title="VMAF"
              metricKey="vmaf_score_encoder"
              data={points}
              series={comparisonSeries(activeLegs, "vmaf_score_encoder", "score")}
              height={280}
              yDomain={[0, 100]}
              keepZeroSeries
            />
            <MetricChart
              title="PSNR"
              metricKey="psnr_db_encoder"
              data={points}
              series={comparisonSeries(activeLegs, "psnr_db_encoder", "dB")}
              height={280}
              keepZeroSeries
            />
            <MetricChart
              title="SSIM"
              metricKey="ssim_encoder"
              data={points}
              series={comparisonSeries(activeLegs, "ssim_encoder", "score")}
              height={280}
              yDomain={[0, 1]}
              keepZeroSeries
            />
          </>
        )}

        {currentGroup.id === "client" && clientGroup && (
          <>
            <MetricChart
              title="Process CPU"
              metricKey="cpu_percent"
              data={points}
              series={comparisonSeries(activeLegs, "cpu_percent", "%")}
              height={260}
            />
            <MetricChart
              title="Process memory"
              metricKey="memory_mb"
              data={points}
              series={comparisonSeries(activeLegs, "memory_mb", "MB")}
              height={260}
            />
          </>
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
            <MetricChart
              title="RTT"
              metricKey="net_rtt_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_rtt_ms", "ms")}
              height={280}
            />
            <MetricChart
              title="Server network jitter"
              metricKey="net_jitter_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_jitter_ms", "ms")}
              height={260}
            />
            <MetricChart
              title="Server CPU"
              metricKey="server_cpu_percent"
              data={points}
              series={comparisonSeries(activeLegs, "server_cpu_percent", "%")}
              height={280}
            />
            <MetricChart
              title="Server memory"
              metricKey="server_memory_percent"
              data={points}
              series={comparisonSeries(activeLegs, "server_memory_percent", "%")}
              height={280}
            />
            <MetricChart
              title="Path loss %"
              metricKey="net_loss_pct"
              data={points}
              series={comparisonSeries(activeLegs, "net_loss_pct", "%")}
              height={260}
              keepZeroSeries
            />
            <MetricChart
              title="Retransmit %"
              metricKey="net_retrans_pct"
              data={points}
              series={comparisonSeries(activeLegs, "net_retrans_pct", "%")}
              height={260}
              keepZeroSeries
            />
            {hasMoqLeg && (
              <>
                <MetricChart
                  title="Receive loss"
                  metricKey="quic_packets_lost"
                  data={points}
                  series={comparisonSeries(activeLegs, "quic_packets_lost", "pkts")}
                  height={260}
                  keepZeroSeries
                />
                {comparisonHasMetric(points, "quic_cwnd_bytes", activeLegs.length) && (
                  <MetricChart
                    title="QUIC congestion window"
                    metricKey="quic_cwnd_bytes"
                    data={points}
                    series={comparisonSeries(activeLegs, "quic_cwnd_bytes", "bytes")}
                    height={260}
                  />
                )}
              </>
            )}
            {hasSrtOrRtmpLeg && (
              <MetricChart
                title="FEC extra"
                metricKey="pkt_fec_extra"
                data={points}
                series={comparisonSeries(activeLegs, "pkt_fec_extra", "pkts")}
                height={260}
                keepZeroSeries
              />
            )}
            <MetricChart
              title="VMAF (ingest)"
              metricKey="vmaf_score_ingest"
              data={points}
              series={comparisonSeries(activeLegs, "vmaf_score_ingest", "score")}
              height={280}
              yDomain={[0, 100]}
              keepZeroSeries
            />
            <MetricChart
              title="PSNR (ingest)"
              metricKey="psnr_db_ingest"
              data={points}
              series={comparisonSeries(activeLegs, "psnr_db_ingest", "dB")}
              height={280}
              keepZeroSeries
            />
            <MetricChart
              title="SSIM (ingest)"
              metricKey="ssim_ingest"
              data={points}
              series={comparisonSeries(activeLegs, "ssim_ingest", "score")}
              height={280}
              yDomain={[0, 1]}
              keepZeroSeries
            />
          </>
        )}

        {currentGroup.id === "media_health" && mediaHealthGroup && (
          <>
            <ChartSectionNote
              title="Media container integrity"
              items={[
                "Measures timeline and container health — not network transport.",
                "MPEG-TS (SRT/RTMP): Zixi TR101 continuity-counter errors.",
                "MoQ CMAF: fragment sequence gaps, decode-time gaps, and parse errors.",
              ]}
            />
            <ProtocolAvailabilityNote metricKey="ts_continuity_counter_errors" legs={activeLegs} />
            <ProtocolAvailabilityNote metricKey="cmaf_seq_gap_count" legs={activeLegs} />
            {comparisonHasMetric(points, "ts_continuity_counter_errors", activeLegs.length) && (
              <MetricChart
                title="TS continuity errors"
                metricKey="ts_continuity_counter_errors"
                data={points}
                series={comparisonSeries(activeLegs, "ts_continuity_counter_errors", "count")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "cmaf_seq_gap_count", activeLegs.length) && (
              <MetricChart
                title="CMAF sequence gaps"
                metricKey="cmaf_seq_gap_count"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_seq_gap_count", "count")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "cmaf_tfdt_gap_count", activeLegs.length) && (
              <MetricChart
                title="CMAF decode-time gaps"
                metricKey="cmaf_tfdt_gap_count"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_tfdt_gap_count", "count")}
                height={220}
              />
            )}
            {comparisonHasMetric(points, "cmaf_tfdt_gap_ms", activeLegs.length) && (
              <MetricChart
                title="CMAF decode-time gap (ms)"
                metricKey="cmaf_tfdt_gap_ms"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_tfdt_gap_ms", "ms")}
                height={220}
              />
            )}
            {comparisonHasMetric(points, "cmaf_parse_errors", activeLegs.length) && (
              <MetricChart
                title="CMAF parse errors"
                metricKey="cmaf_parse_errors"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_parse_errors", "count")}
                height={220}
              />
            )}
          </>
        )}

        {currentGroup.id === "playback" && playbackGroup && (
          <>
            {comparisonHasMetric(points, "e2e_latency_ms", activeLegs.length) && (
              <MetricChart
                title="E2E latency (estimated)"
                metricKey="e2e_latency_ms"
                data={points}
                series={comparisonSeries(activeLegs, "e2e_latency_ms", "ms")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "playback_ttff_ms", activeLegs.length) && (
              <MetricChart
                title="Time to first frame"
                metricKey="playback_ttff_ms"
                data={points}
                series={comparisonSeries(activeLegs, "playback_ttff_ms", "ms")}
                height={220}
              />
            )}
            {(comparisonHasMetricPresent(points, "playback_stall_count", activeLegs.length) ||
              comparisonHasMetric(points, "playback_ttff_ms", activeLegs.length) ||
              comparisonHasMetric(points, "playback_video_time_sec", activeLegs.length)) && (
              <MetricChart
                title="Playback stalls"
                metricKey="playback_stall_count"
                data={points}
                series={comparisonSeries(activeLegs, "playback_stall_count", "count")}
                height={260}
                keepZeroSeries
              />
            )}
            {comparisonHasMetric(points, "playback_rebuffer_sec", activeLegs.length) && (
              <MetricChart
                title="Rebuffer time"
                metricKey="playback_rebuffer_sec"
                data={points}
                series={comparisonSeries(activeLegs, "playback_rebuffer_sec", "s")}
                height={220}
                keepZeroSeries
              />
            )}
            {comparisonHasMetric(points, "playback_buffer_sec", activeLegs.length) && (
              <MetricChart
                title="Buffer size"
                metricKey="playback_buffer_sec"
                data={points}
                series={comparisonSeries(activeLegs, "playback_buffer_sec", "s")}
                height={220}
              />
            )}
            {comparisonHasMetric(points, "playback_video_time_sec", activeLegs.length) && (
              <MetricChart
                title="Video playback time"
                metricKey="playback_video_time_sec"
                data={points}
                series={comparisonSeries(activeLegs, "playback_video_time_sec", "s")}
                height={220}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
