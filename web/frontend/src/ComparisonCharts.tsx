import { useEffect, useMemo, useState } from "react";
import {
  LEG_COLORS,
  chartGroupById,
  comparisonHasMetric,
  comparisonSeries,
  comparisonVisibleGroups,
  buildComparisonPoints,
  type ComparisonLegData,
} from "./chartData";
import { MetricChart } from "./MetricChart";
import { metricUnavailableMessage, metricSupportedForProtocol } from "./metricModel";

interface ComparisonChartsProps {
  legs: ComparisonLegData[];
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
  const transportGroup = chartGroupById("transport");
  const clientGroup = chartGroupById("client");
  const serverGroup = chartGroupById("server");
  const relayGroup = chartGroupById("edge_relay");
  const zixiGroup = chartGroupById("edge_zixi");
  const mediaHealthGroup = chartGroupById("media_health");
  const playbackGroup = chartGroupById("playback");
  const qualityGroup = chartGroupById("video_quality");

  if (activeLegs.length < 2) {
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
              metricKey="encoded_bitrate_kbps"
              data={points}
              series={comparisonSeries(activeLegs, "encoded_bitrate_kbps", "kbps")}
              height={260}
            />
            <MetricChart
              title="Frame rate"
              metricKey="fps"
              data={points}
              series={comparisonSeries(activeLegs, "fps", "fps")}
              height={260}
            />
            {comparisonHasMetric(points, "encode_lag_ms", activeLegs.length) && (
              <MetricChart
                title="Encode lag"
                metricKey="encode_lag_ms"
                data={points}
                series={comparisonSeries(activeLegs, "encode_lag_ms", "ms")}
                height={220}
              />
            )}
          </>
        )}

        {currentGroup.id === "transport" && transportGroup && (
          <>
            <p className="hint chart-availability-note">
              Normalized transport: SRT uses libsrt/Zixi RTT; RTMP uses Zixi receiver RTT when
              available, otherwise a TCP path probe to the RTMP host:port; MoQ uses QUIC qlog RTT
              when available, otherwise a TCP path probe to the relay (same host as WebTransport).
            </p>
            <MetricChart
              title="RTT (normalized)"
              metricKey="net_rtt_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_rtt_ms", "ms")}
              height={260}
            />
            <MetricChart
              title="Jitter (normalized)"
              metricKey="net_jitter_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_jitter_ms", "ms")}
              height={220}
            />
            <MetricChart
              title="Send rate (normalized)"
              metricKey="net_send_mbps"
              data={points}
              series={comparisonSeries(activeLegs, "net_send_mbps", "Mbps")}
              height={260}
            />
            <MetricChart
              title="Loss %"
              metricKey="net_loss_pct"
              data={points}
              series={comparisonSeries(activeLegs, "net_loss_pct", "%")}
              height={220}
            />
            <MetricChart
              title="Retransmit %"
              metricKey="net_retrans_pct"
              data={points}
              series={comparisonSeries(activeLegs, "net_retrans_pct", "%")}
              height={220}
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

        {currentGroup.id === "server" && serverGroup && (
          <>
            <MetricChart
              title="Server CPU"
              metricKey="server_cpu_percent"
              data={points}
              series={comparisonSeries(activeLegs, "server_cpu_percent", "%")}
              height={260}
            />
            <MetricChart
              title="Server memory"
              metricKey="server_memory_percent"
              data={points}
              series={comparisonSeries(activeLegs, "server_memory_percent", "%")}
              height={260}
            />
          </>
        )}

        {currentGroup.id === "edge_relay" && relayGroup && (
          <>
            <ProtocolAvailabilityNote metricKey="moqx_subscribe_success" legs={activeLegs} />
            <p className="hint chart-availability-note">
              MoQ relay counters are job-window deltas (not absolute since relay restart).
            </p>
            <MetricChart
              title="Subscribe OK (Δ)"
              metricKey="moqx_subscribe_success"
              data={points}
              series={comparisonSeries(activeLegs, "moqx_subscribe_success", "count")}
              height={260}
            />
            <MetricChart
              title="Objects received (Δ)"
              metricKey="moqx_publish_received"
              data={points}
              series={comparisonSeries(activeLegs, "moqx_publish_received", "count")}
              height={260}
            />
            {comparisonHasMetric(points, "quic_cwnd_bytes", activeLegs.length) && (
              <MetricChart
                title="QUIC congestion window"
                metricKey="quic_cwnd_bytes"
                data={points}
                series={comparisonSeries(activeLegs, "quic_cwnd_bytes", "bytes")}
                height={220}
              />
            )}
          </>
        )}

        {currentGroup.id === "edge_zixi" && zixiGroup && (
          <>
            <ProtocolAvailabilityNote metricKey="pkt_retrans" legs={activeLegs} />
            <p className="hint chart-availability-note">
              Libsrt recovery counters from the SRT sender. A flat zero line means a clean path
              (no retransmits / FEC extras observed).
            </p>
            <MetricChart
              title="SRT retransmits"
              metricKey="pkt_retrans"
              data={points}
              series={comparisonSeries(activeLegs, "pkt_retrans", "pkts")}
              height={220}
            />
            <MetricChart
              title="Send loss"
              metricKey="pkt_snd_loss"
              data={points}
              series={comparisonSeries(activeLegs, "pkt_snd_loss", "pkts")}
              height={220}
            />
            <MetricChart
              title="FEC extra"
              metricKey="pkt_fec_extra"
              data={points}
              series={comparisonSeries(activeLegs, "pkt_fec_extra", "pkts")}
              height={220}
            />
          </>
        )}

        {currentGroup.id === "media_health" && mediaHealthGroup && (
          <>
            <p className="hint chart-availability-note">
              Media Health is container/timeline integrity — not transport. MPEG-TS uses Zixi TR101
              continuity; MoQ uses CMAF fragment sequence and decode-time checks.
            </p>
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
            {comparisonHasMetric(points, "playback_stall_count", activeLegs.length) && (
              <MetricChart
                title="Playback stalls"
                metricKey="playback_stall_count"
                data={points}
                series={comparisonSeries(activeLegs, "playback_stall_count", "count")}
                height={260}
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

        {currentGroup.id === "video_quality" && qualityGroup && (
          <>
            {comparisonHasMetric(points, "vmaf_score", activeLegs.length) && (
              <MetricChart
                title="VMAF score"
                metricKey="vmaf_score"
                data={points}
                series={comparisonSeries(activeLegs, "vmaf_score", "score")}
                height={260}
                yDomain={[0, 100]}
              />
            )}
            {comparisonHasMetric(points, "psnr_db", activeLegs.length) && (
              <MetricChart
                title="PSNR"
                metricKey="psnr_db"
                data={points}
                series={comparisonSeries(activeLegs, "psnr_db", "dB")}
                height={260}
              />
            )}
            {comparisonHasMetric(points, "ssim", activeLegs.length) && (
              <MetricChart
                title="SSIM"
                metricKey="ssim"
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
