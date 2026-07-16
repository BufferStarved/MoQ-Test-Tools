import { useEffect, useMemo, useState } from "react";
import {
  CHART_GROUPS,
  LEG_COLORS,
  buildComparisonPointsFromResults,
  chartGroupById,
  comparisonHasMetric,
  comparisonSeries,
  comparisonVisibleGroups,
  resultToSavedStream,
  savedStreamsToLegs,
  type SavedStreamData,
} from "./chartData";
import { MetricChart } from "./MetricChart";
import { SummaryMetric } from "./MetricLabel";
import type { ResultSummary } from "./types";

interface ResultsViewProps {
  streams: ResultSummary[];
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

function StreamSummary({ result }: { result: ResultSummary }) {
  const averages = result.averages;
  const throughput = result.throughput;

  return (
    <div className="metrics-grid results-summary-grid">
      <SummaryMetric metricKey="protocol" value={result.protocol} />
      <SummaryMetric metricKey="samples" value={String(result.samples)} />
      <SummaryMetric
        metricKey="encoded_bitrate_kbps"
        label="Avg bitrate"
        value={`${averages.encoded_bitrate_kbps} kbps`}
      />
      <SummaryMetric metricKey="fps" label="Avg FPS" value={String(averages.fps ?? "—")} />
      <SummaryMetric metricKey="fps_stability" value={String(averages.fps_stability ?? "—")} />
      <SummaryMetric metricKey="speed" label="Avg speed" value={`${averages.speed}x`} />
      <SummaryMetric
        metricKey="transport_rtt_ms"
        label="Avg RTT"
        value={averages.transport_rtt_ms ? `${averages.transport_rtt_ms} ms` : "—"}
      />
      <SummaryMetric
        metricKey="transport_rtt_jitter_ms"
        label="Avg jitter"
        value={averages.transport_rtt_jitter_ms ? `${averages.transport_rtt_jitter_ms} ms` : "—"}
      />
      <SummaryMetric metricKey="pkt_rcv_drop" value={String(averages.pkt_rcv_drop ?? "—")} />
      <SummaryMetric metricKey="pkt_retrans" value={String(averages.pkt_retrans ?? "—")} />
      <SummaryMetric metricKey="pkt_fec_extra" value={String(averages.pkt_fec_extra ?? "—")} />
      <SummaryMetric
        metricKey="ts_continuity_counter_errors"
        value={String(averages.ts_continuity_counter_errors ?? "—")}
      />
      {averages.vmaf_score != null && !result.quality?.ingest?.vmaf_score && (
        <SummaryMetric metricKey="vmaf_score" label="VMAF (post-ingest)" value={String(averages.vmaf_score)} />
      )}
      {result.quality?.encoder?.vmaf_score != null && (
        <SummaryMetric
          metricKey="vmaf_score"
          label="VMAF (encoder)"
          value={String(result.quality.encoder.vmaf_score)}
        />
      )}
      {result.quality?.ingest?.vmaf_score != null && (
        <SummaryMetric
          metricKey="vmaf_score"
          label="VMAF (ingest)"
          value={String(result.quality.ingest.vmaf_score)}
        />
      )}
      {averages.psnr_db != null && !result.quality?.ingest?.psnr_db && (
        <SummaryMetric metricKey="psnr_db" label="PSNR (post-ingest)" value={`${averages.psnr_db} dB`} />
      )}
      {result.quality?.encoder?.psnr_db != null && (
        <SummaryMetric
          metricKey="psnr_db"
          label="PSNR (encoder)"
          value={`${result.quality.encoder.psnr_db} dB`}
        />
      )}
      {result.quality?.ingest?.psnr_db != null && (
        <SummaryMetric
          metricKey="psnr_db"
          label="PSNR (ingest)"
          value={`${result.quality.ingest.psnr_db} dB`}
        />
      )}
      {averages.ssim != null && !result.quality?.ingest?.ssim && (
        <SummaryMetric metricKey="ssim" label="SSIM (post-ingest)" value={String(averages.ssim)} />
      )}
      {result.quality?.encoder?.ssim != null && (
        <SummaryMetric metricKey="ssim" label="SSIM (encoder)" value={String(result.quality.encoder.ssim)} />
      )}
      {result.quality?.ingest?.ssim != null && (
        <SummaryMetric metricKey="ssim" label="SSIM (ingest)" value={String(result.quality.ingest.ssim)} />
      )}
      <SummaryMetric metricKey="total_bytes_sent" value={formatBytes(throughput?.total_bytes_sent)} />
      <SummaryMetric metricKey="total_bytes_received" value={formatBytes(throughput?.total_bytes_received)} />
      <SummaryMetric
        metricKey="peak_bandwidth_sent_mbps"
        value={throughput?.peak_bandwidth_sent_mbps ? `${throughput.peak_bandwidth_sent_mbps} Mbps` : "—"}
      />
      <SummaryMetric
        metricKey="peak_bandwidth_received_mbps"
        value={throughput?.peak_bandwidth_received_mbps ? `${throughput.peak_bandwidth_received_mbps} Mbps` : "—"}
      />
      {(averages.client_memory_percent ?? 0) > 0 && (
        <SummaryMetric metricKey="client_memory_percent" label="Avg client host memory" value={`${averages.client_memory_percent}%`} />
      )}
      {(averages.client_disk_percent ?? 0) > 0 && (
        <SummaryMetric metricKey="client_disk_percent" label="Avg client host disk" value={`${averages.client_disk_percent}%`} />
      )}
      {(averages.server_cpu_percent ?? 0) > 0 && (
        <SummaryMetric metricKey="server_cpu_percent" label="Avg server CPU" value={`${averages.server_cpu_percent}%`} />
      )}
      {(averages.server_memory_percent ?? 0) > 0 && (
        <SummaryMetric metricKey="server_memory_percent" label="Avg server memory" value={`${averages.server_memory_percent}%`} />
      )}
      {(averages.server_disk_percent ?? 0) > 0 && (
        <SummaryMetric metricKey="server_disk_percent" label="Avg server disk" value={`${averages.server_disk_percent}%`} />
      )}
    </div>
  );
}

function metricChart(
  metricKey: string,
  title: string,
  points: ReturnType<typeof buildComparisonPointsFromResults>,
  legs: SavedStreamData[],
  unit?: string,
  yDomain?: [number, number],
) {
  if (!comparisonHasMetric(points, metricKey, legs.length)) {
    return null;
  }
  const seriesMeta = CHART_GROUPS.flatMap((group) => group.series).find((series) => series.key === metricKey);
  return (
    <MetricChart
      key={metricKey}
      title={title}
      metricKey={metricKey}
      data={points}
      series={comparisonSeries(savedStreamsToLegs(legs), metricKey, unit ?? seriesMeta?.unit)}
      height={240}
      yDomain={yDomain}
    />
  );
}

export function ResultsView({ streams }: ResultsViewProps) {
  const savedStreams = useMemo(
    () => streams.map((result, index) => resultToSavedStream(result, index)),
    [streams],
  );
  const points = useMemo(() => buildComparisonPointsFromResults(savedStreams), [savedStreams]);
  const legs = savedStreams;
  const groups = useMemo(
    () => comparisonVisibleGroups(points, savedStreamsToLegs(savedStreams)),
    [points, savedStreams],
  );
  const [activeStreamIndex, setActiveStreamIndex] = useState(0);
  const [activeGroup, setActiveGroup] = useState(groups[0]?.id ?? "encode");

  useEffect(() => {
    if (activeStreamIndex >= streams.length) {
      setActiveStreamIndex(0);
    }
  }, [activeStreamIndex, streams.length]);

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
  const qualityGroup = chartGroupById("quality");

  if (streams.length === 0) {
    return <p className="muted">Select a saved run to view charts and metrics.</p>;
  }

  const activeResult = streams[activeStreamIndex];

  return (
    <div className="results-view">
      <div className="results-header">
        <div>
          <h3>{streams.length > 1 ? `Comparison · ${streams.length} streams` : streams[0].filename}</h3>
          <p className="hint">
            {streams.length > 1
              ? "Charts overlay each stream as its own time series. Summary metrics are shown per stream below."
              : streams[0].endpoint}
          </p>
        </div>
        <a
          className="csv-download"
          href={`/api/results/${encodeURIComponent(activeResult.filename)}`}
          target="_blank"
          rel="noreferrer"
        >
          Raw JSON
        </a>
      </div>

      <div className="stream-summary-panel">
        <div className="stream-tabs">
          {savedStreams.map((stream, index) => (
            <button
              key={stream.id}
              type="button"
              className={index === activeStreamIndex ? "active" : ""}
              onClick={() => setActiveStreamIndex(index)}
            >
              <span className="stream-tab-swatch" style={{ background: LEG_COLORS[index % LEG_COLORS.length] }} />
              {stream.label}
            </button>
          ))}
        </div>
        <div className="stream-summary-card">
          <p className="hint endpoint-copy">{activeResult.endpoint}</p>
          <StreamSummary result={activeResult} />
          {activeResult.summary_extra?.vmaf_computed_on === "ingest_agent" && (
            <p className="hint">
              Quality metrics computed by ingest HTTP agent
              {activeResult.summary_extra.vmaf_distorted_path
                ? ` using recording ${activeResult.summary_extra.vmaf_distorted_path}`
                : ""}
              .
            </p>
          )}
        </div>
      </div>

      {points.length > 0 && currentGroup && (
        <div className="charts-panel results-charts-panel">
          <div className="charts-toolbar">
            <div className="chart-group-tabs">
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={group.id === currentGroup.id ? "active" : ""}
                  onClick={() => setActiveGroup(group.id)}
                >
                  {group.title}
                </button>
              ))}
            </div>
            <span className="charts-meta">{points.length} seconds · {legs.length} streams</span>
          </div>

          <div className="comparison-legend">
            {savedStreams.map((stream, index) => (
              <span key={stream.id} className="comparison-legend-item">
                <span className="comparison-swatch" style={{ background: LEG_COLORS[index % LEG_COLORS.length] }} />
                {stream.label}
              </span>
            ))}
          </div>

          <div className="charts-grid results-metric-grid">
            {currentGroup.id === "encode" && encodeGroup && (
              <>
                {metricChart("encoded_bitrate_kbps", "Bitrate", points, legs)}
                {metricChart("fps", "Frame rate", points, legs)}
                {metricChart("speed", "Speed", points, legs)}
                {metricChart("fps_stability", "FPS stability", points, legs)}
              </>
            )}
            {currentGroup.id === "network" && networkGroup && (
              <>
                {metricChart("transport_rtt_ms", "RTT", points, legs)}
                {metricChart("transport_rtt_jitter_ms", "Jitter", points, legs)}
                {metricChart("pkt_retrans", "Retransmits", points, legs)}
                {metricChart("pkt_rcv_drop", "pktRcvDrop", points, legs)}
                {metricChart("pkt_snd_drop", "pktSndDrop", points, legs)}
                {metricChart("pkt_fec_extra", "FEC extra", points, legs)}
                {metricChart("ts_continuity_counter_errors", "CC errors", points, legs)}
              </>
            )}
            {currentGroup.id === "bandwidth" && bandwidthGroup && (
              <>
                {metricChart("encoder_send_rate_mbps", "Send rate", points, legs)}
                {metricChart("transport_recv_rate_mbps", "Receive rate", points, legs)}
              </>
            )}
            {currentGroup.id === "system" && systemGroup && (
              <>
                {metricChart("cpu_percent", "Process CPU", points, legs)}
                {metricChart("memory_mb", "Process memory", points, legs)}
                {metricChart("client_memory_percent", "Client host memory", points, legs)}
                {metricChart("client_disk_percent", "Client host disk", points, legs)}
              </>
            )}
            {currentGroup.id === "server" && serverGroup && (
              <>
                {metricChart("server_cpu_percent", "Server CPU", points, legs)}
                {metricChart("server_memory_percent", "Server memory", points, legs)}
                {metricChart("server_disk_percent", "Server disk", points, legs)}
              </>
            )}
            {currentGroup.id === "quality" && qualityGroup && (
              <>
                {metricChart("vmaf_score", "VMAF", points, legs, "score", [0, 100])}
                {metricChart("psnr_db", "PSNR", points, legs, "dB")}
                {metricChart("ssim", "SSIM", points, legs, "score", [0, 1])}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
