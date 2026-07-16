import { useEffect, useMemo, useState } from "react";
import {
  applyVmafScore,
  chartGroupById,
  resultToChartPoints,
  samplesToChartPoints,
  visibleGroups,
  type ChartPoint,
} from "./chartData";
import { MetricChart } from "./MetricChart";
import type { ResultSummary, UploadSample } from "./types";

interface ResultChartsProps {
  result?: ResultSummary | null;
  liveSamples?: UploadSample[];
  protocol?: string;
  vmafScore?: number | null;
}

export function ResultCharts({ result, liveSamples = [], protocol, vmafScore }: ResultChartsProps) {
  const points = useMemo<ChartPoint[]>(() => {
    if (result) {
      return resultToChartPoints(result);
    }
    const livePoints = samplesToChartPoints(liveSamples);
    return applyVmafScore(livePoints, vmafScore);
  }, [result, liveSamples, vmafScore]);

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
  const networkGroup = chartGroupById("network");
  const bandwidthGroup = chartGroupById("bandwidth");
  const systemGroup = chartGroupById("system");
  const serverGroup = chartGroupById("server");
  const moqxGroup = chartGroupById("moqx");
  const quicGroup = chartGroupById("quic");
  const playbackGroup = chartGroupById("playback");
  const qualityGroup = chartGroupById("quality");

  if (points.length === 0) {
    return (
      <div className="charts-empty muted">
        No telemetry samples yet. Run a benchmark to see live charts, or select a saved result.
      </div>
    );
  }

  if (!currentGroup) {
    return (
      <div className="charts-empty muted">
        No plottable metrics in this result.
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
        <span className="charts-meta">{points.length} samples</span>
      </div>

      <div className="charts-grid">
        {currentGroup.id === "encode" && encodeGroup && (
          <>
            <MetricChart
              title="Bitrate & frame rate"
              data={points}
              series={encodeGroup.series.filter(
                (series) => series.key === "encoded_bitrate_kbps" || series.key === "fps",
              )}
              height={260}
            />
            <MetricChart
              title="Speed & stability"
              data={points}
              series={encodeGroup.series.filter((series) => series.key === "speed" || series.key === "fps_stability")}
              height={260}
            />
          </>
        )}
        {currentGroup.id === "network" && networkGroup && (
          <>
            <MetricChart
              title="RTT & jitter"
              data={points}
              series={networkGroup.series.filter(
                (series) =>
                  series.key === "transport_rtt_ms" || series.key === "transport_rtt_jitter_ms",
              )}
              height={260}
            />
            <MetricChart
              title="Loss & recovery"
              data={points}
              series={networkGroup.series.filter(
                (series) =>
                  series.key === "pkt_retrans" ||
                  series.key === "pkt_rcv_drop" ||
                  series.key === "pkt_snd_drop" ||
                  series.key === "pkt_fec_extra",
              )}
              height={260}
            />
            {hasData(points, "ts_continuity_counter_errors") && (
              <MetricChart
                title="Continuity counter errors"
                data={points}
                series={networkGroup.series.filter(
                  (series) => series.key === "ts_continuity_counter_errors",
                )}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "bandwidth" && bandwidthGroup && (
          <MetricChart
            title="Send & receive rate"
            data={points}
            series={bandwidthGroup.series}
            height={260}
          />
        )}
        {currentGroup.id === "system" && systemGroup && (
          <MetricChart
            title="Client (ffmpeg host)"
            data={points}
            series={systemGroup.series}
            height={260}
          />
        )}
        {currentGroup.id === "server" && serverGroup && (
          <MetricChart
            title="Server (ingest / relay host)"
            data={points}
            series={serverGroup.series}
            height={260}
          />
        )}
        {currentGroup.id === "moqx" && moqxGroup && (
          <>
            <MetricChart
              title="Relay subscribe outcomes"
              data={points}
              series={moqxGroup.series.filter(
                (series) => series.key === "moqx_subscribe_success" || series.key === "moqx_subscribe_error",
              )}
              height={260}
            />
            <MetricChart
              title="Relay publish activity"
              data={points}
              series={moqxGroup.series.filter(
                (series) =>
                  series.key === "moqx_publish_namespace_success" ||
                  series.key === "moqx_publish_received" ||
                  series.key === "moqx_publish_done",
              )}
              height={260}
            />
          </>
        )}
        {currentGroup.id === "quic" && quicGroup && (
          <>
            <MetricChart
              title="QUIC RTT & congestion window"
              data={points}
              series={quicGroup.series.filter(
                (series) => series.key === "quic_rtt_ms" || series.key === "quic_cwnd_bytes",
              )}
              height={260}
            />
            {hasData(points, "quic_packets_lost") && (
              <MetricChart
                title="QUIC packets lost"
                data={points}
                series={quicGroup.series.filter((series) => series.key === "quic_packets_lost")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "playback" && playbackGroup && (
          <>
            <MetricChart
              title="MoQ playback stats"
              data={points}
              series={playbackGroup.series.filter(
                (series) =>
                  series.key === "playback_stats_events" ||
                  series.key === "playback_frames_rendered" ||
                  series.key === "playback_stall_count",
              )}
              height={260}
            />
            <MetricChart
              title="HLS playback health"
              data={points}
              series={playbackGroup.series.filter(
                (series) =>
                  series.key === "playback_hls_errors" ||
                  series.key === "playback_hls_buffer_stalls" ||
                  series.key === "playback_hls_frag_loads",
              )}
              height={260}
            />
            {hasData(points, "playback_video_time_sec") && (
              <MetricChart
                title="Video playback time"
                data={points}
                series={playbackGroup.series.filter((series) => series.key === "playback_video_time_sec")}
                height={220}
              />
            )}
          </>
        )}
        {currentGroup.id === "quality" && qualityGroup && (
          <MetricChart
            title="Quality (post-ingest)"
            data={points}
            series={qualityGroup.series.filter((series) => hasData(points, series.key))}
            height={260}
          />
        )}
      </div>
    </div>
  );
}

function hasData(points: ChartPoint[], key: string): boolean {
  return points.some((point) => point[key] > 0);
}
