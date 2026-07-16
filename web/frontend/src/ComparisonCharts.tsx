import { useEffect, useMemo, useState } from "react";
import {
  CHART_GROUPS,
  LEG_COLORS,
  chartGroupById,
  comparisonHasMetric,
  comparisonSeries,
  comparisonVisibleGroups,
  buildComparisonPoints,
  type ComparisonLegData,
} from "./chartData";
import { MetricChart } from "./MetricChart";

interface ComparisonChartsProps {
  legs: ComparisonLegData[];
}

export function ComparisonCharts({ legs }: ComparisonChartsProps) {
  const activeLegs = legs.filter((leg) => leg.samples.length > 0);
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
  const networkGroup = chartGroupById("network");
  const bandwidthGroup = chartGroupById("bandwidth");
  const systemGroup = chartGroupById("system");
  const serverGroup = chartGroupById("server");
  const moqxGroup = chartGroupById("moqx");
  const quicGroup = chartGroupById("quic");
  const playbackGroup = chartGroupById("playback");
  const qualityGroup = chartGroupById("quality");

  if (activeLegs.length < 2) {
    return (
      <div className="charts-empty muted">
        Waiting for uploads to produce telemetry...
      </div>
    );
  }

  if (points.length === 0 || !currentGroup) {
    return (
      <div className="charts-empty muted">
        No comparison data yet.
      </div>
    );
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
        <span className="charts-meta">{points.length} seconds · {activeLegs.length} legs</span>
      </div>

      <div className="comparison-legend">
        {activeLegs.map((leg, index) => (
          <span key={leg.id} className="comparison-legend-item">
            <span
              className="comparison-swatch"
              style={{ background: LEG_COLORS[index % LEG_COLORS.length] }}
            />
            {leg.label}
          </span>
        ))}
      </div>

      <div className="charts-grid">
        {currentGroup.id === "encode" && encodeGroup && (
          <>
            <MetricChart
              title="Bitrate"
              data={points}
              series={comparisonSeries(activeLegs, "encoded_bitrate_kbps", "kbps")}
              height={260}
            />
            <MetricChart
              title="Frame rate"
              data={points}
              series={comparisonSeries(activeLegs, "fps", "fps")}
              height={260}
            />
          </>
        )}
        {currentGroup.id === "network" && networkGroup && (
          <>
            <MetricChart
              title="RTT"
              data={points}
              series={comparisonSeries(activeLegs, "transport_rtt_ms", "ms")}
              height={260}
            />
            {comparisonHasMetric(points, "transport_rtt_jitter_ms", activeLegs.length) && (
              <MetricChart
                title="Transport jitter"
                data={points}
                series={comparisonSeries(activeLegs, "transport_rtt_jitter_ms", "ms")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "pkt_retrans", activeLegs.length) && (
              <MetricChart
                title="Retransmits"
                data={points}
                series={comparisonSeries(activeLegs, "pkt_retrans", "pkts")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "bandwidth" && bandwidthGroup && (
          <>
            <MetricChart
              title="Send rate"
              data={points}
              series={comparisonSeries(activeLegs, "encoder_send_rate_mbps", "Mbps")}
              height={260}
            />
            <MetricChart
              title="Receive rate"
              data={points}
              series={comparisonSeries(activeLegs, "transport_recv_rate_mbps", "Mbps")}
              height={260}
            />
          </>
        )}
        {currentGroup.id === "system" && systemGroup && (
          <>
            <MetricChart
              title="Process CPU"
              data={points}
              series={comparisonSeries(activeLegs, "cpu_percent", "%")}
              height={260}
            />
            <MetricChart
              title="Process memory"
              data={points}
              series={comparisonSeries(activeLegs, "memory_mb", "MB")}
              height={260}
            />
            {comparisonHasMetric(points, "client_memory_percent", activeLegs.length) && (
              <MetricChart
                title="Client host memory"
                data={points}
                series={comparisonSeries(activeLegs, "client_memory_percent", "%")}
                height={220}
              />
            )}
            {comparisonHasMetric(points, "client_disk_percent", activeLegs.length) && (
              <MetricChart
                title="Client host disk"
                data={points}
                series={comparisonSeries(activeLegs, "client_disk_percent", "%")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "server" && serverGroup && (
          <>
            <MetricChart
              title="Server CPU"
              data={points}
              series={comparisonSeries(activeLegs, "server_cpu_percent", "%")}
              height={260}
            />
            <MetricChart
              title="Server memory"
              data={points}
              series={comparisonSeries(activeLegs, "server_memory_percent", "%")}
              height={260}
            />
            {comparisonHasMetric(points, "server_disk_percent", activeLegs.length) && (
              <MetricChart
                title="Server disk"
                data={points}
                series={comparisonSeries(activeLegs, "server_disk_percent", "%")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "moqx" && moqxGroup && (
          <>
            <MetricChart
              title="Relay subscribe OK"
              data={points}
              series={comparisonSeries(activeLegs, "moqx_subscribe_success", "count")}
              height={260}
            />
            {comparisonHasMetric(points, "moqx_subscribe_error", activeLegs.length) && (
              <MetricChart
                title="Relay subscribe errors"
                data={points}
                series={comparisonSeries(activeLegs, "moqx_subscribe_error", "count")}
                height={220}
              />
            )}
            <MetricChart
              title="Relay objects received"
              data={points}
              series={comparisonSeries(activeLegs, "moqx_publish_received", "count")}
              height={260}
            />
          </>
        )}
        {currentGroup.id === "quic" && quicGroup && (
          <>
            {comparisonHasMetric(points, "quic_rtt_ms", activeLegs.length) && (
              <MetricChart
                title="QUIC RTT"
                data={points}
                series={comparisonSeries(activeLegs, "quic_rtt_ms", "ms")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "quic_cwnd_bytes", activeLegs.length) && (
              <MetricChart
                title="QUIC congestion window"
                data={points}
                series={comparisonSeries(activeLegs, "quic_cwnd_bytes", "bytes")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "quic_packets_lost", activeLegs.length) && (
              <MetricChart
                title="QUIC packets lost"
                data={points}
                series={comparisonSeries(activeLegs, "quic_packets_lost", "count")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "playback" && playbackGroup && (
          <>
            {comparisonHasMetric(points, "playback_stall_count", activeLegs.length) && (
              <MetricChart
                title="Playback stalls"
                data={points}
                series={comparisonSeries(activeLegs, "playback_stall_count", "count")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "playback_stats_events", activeLegs.length) && (
              <MetricChart
                title="Playa stats events"
                data={points}
                series={comparisonSeries(activeLegs, "playback_stats_events", "count")}
                height={220}
              />
            )}
            {comparisonHasMetric(points, "playback_hls_errors", activeLegs.length) && (
              <MetricChart
                title="HLS errors"
                data={points}
                series={comparisonSeries(activeLegs, "playback_hls_errors", "count")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "playback_video_time_sec", activeLegs.length) && (
              <MetricChart
                title="Video playback time"
                data={points}
                series={comparisonSeries(activeLegs, "playback_video_time_sec", "s")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "quality" && qualityGroup && (
          <>
            {comparisonHasMetric(points, "vmaf_score", activeLegs.length) && (
              <MetricChart
                title="VMAF score"
                data={points}
                series={comparisonSeries(activeLegs, "vmaf_score", "score")}
                height={260}
                yDomain={[0, 100]}
              />
            )}
            {comparisonHasMetric(points, "psnr_db", activeLegs.length) && (
              <MetricChart
                title="PSNR"
                data={points}
                series={comparisonSeries(activeLegs, "psnr_db", "dB")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "ssim", activeLegs.length) && (
              <MetricChart
                title="SSIM"
                data={points}
                series={comparisonSeries(activeLegs, "ssim", "score")}
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
