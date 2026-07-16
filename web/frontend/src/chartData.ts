import type { ResultSummary, UploadSample } from "./types";

export interface ChartPoint {
  second: number;
  [key: string]: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  unit?: string;
}

export interface ChartGroup {
  id: string;
  title: string;
  series: ChartSeries[];
}

export const CHART_GROUPS: ChartGroup[] = [
  {
    id: "encode",
    title: "Encode & throughput",
    series: [
      { key: "encoded_bitrate_kbps", label: "Encoded bitrate", color: "#22d3ee", unit: "kbps" },
      { key: "fps", label: "Frame rate", color: "#4ade80", unit: "fps" },
      { key: "speed", label: "Speed", color: "#38bdf8", unit: "x" },
      { key: "fps_stability", label: "FPS stability", color: "#a3e635", unit: "cv" },
    ],
  },
  {
    id: "network",
    title: "Network (SRT)",
    series: [
      { key: "transport_rtt_ms", label: "Transport RTT", color: "#fbbf24", unit: "ms" },
      { key: "transport_rtt_jitter_ms", label: "Transport jitter", color: "#fb923c", unit: "ms" },
      { key: "pkt_retrans", label: "Retransmits", color: "#f87171", unit: "pkts" },
      { key: "pkt_rcv_drop", label: "pktRcvDrop", color: "#ef4444", unit: "pkts" },
      { key: "pkt_snd_drop", label: "pktSndDrop", color: "#dc2626", unit: "pkts" },
      { key: "pkt_fec_extra", label: "FEC extra", color: "#c084fc", unit: "pkts" },
      { key: "ts_continuity_counter_errors", label: "TS CC errors", color: "#e879f9", unit: "count" },
    ],
  },
  {
    id: "bandwidth",
    title: "Bandwidth",
    series: [
      { key: "encoder_send_rate_mbps", label: "Encoder send rate", color: "#38bdf8", unit: "Mbps" },
      { key: "transport_recv_rate_mbps", label: "Transport receive rate", color: "#818cf8", unit: "Mbps" },
    ],
  },
  {
    id: "system",
    title: "Client (ffmpeg host)",
    series: [
      { key: "cpu_percent", label: "Process CPU", color: "#a78bfa", unit: "%" },
      { key: "memory_mb", label: "Process memory", color: "#f472b6", unit: "MB" },
      { key: "client_memory_percent", label: "Host memory", color: "#c084fc", unit: "%" },
      { key: "client_disk_percent", label: "Host disk", color: "#e879f9", unit: "%" },
    ],
  },
  {
    id: "server",
    title: "Server (ingest / relay host)",
    series: [
      { key: "server_cpu_percent", label: "Server CPU", color: "#60a5fa", unit: "%" },
      { key: "server_memory_percent", label: "Server memory", color: "#34d399", unit: "%" },
      { key: "server_disk_percent", label: "Server disk", color: "#fbbf24", unit: "%" },
    ],
  },
  {
    id: "quic",
    title: "Network (QUIC / picoquic)",
    series: [
      { key: "quic_rtt_ms", label: "QUIC RTT", color: "#38bdf8", unit: "ms" },
      { key: "quic_cwnd_bytes", label: "Congestion window", color: "#818cf8", unit: "bytes" },
      { key: "quic_packets_lost", label: "Packets lost", color: "#f87171", unit: "pkts" },
    ],
  },
  {
    id: "moqx",
    title: "Network (MoQ relay)",
    series: [
      { key: "moqx_subscribe_success", label: "Relay subscribe OK", color: "#60a5fa", unit: "count" },
      { key: "moqx_subscribe_error", label: "Relay subscribe errors", color: "#f87171", unit: "count" },
      { key: "moqx_publish_namespace_success", label: "Relay publish OK", color: "#4ade80", unit: "count" },
      { key: "moqx_publish_received", label: "Relay objects received", color: "#a3e635", unit: "count" },
      { key: "moqx_publish_done", label: "Relay publish sessions closed", color: "#c084fc", unit: "count" },
    ],
  },
  {
    id: "quality",
    title: "Quality (post-ingest)",
    series: [
      { key: "vmaf_score", label: "VMAF", color: "#34d399", unit: "score" },
      { key: "psnr_db", label: "PSNR", color: "#2dd4bf", unit: "dB" },
      { key: "ssim", label: "SSIM", color: "#22d3ee", unit: "score" },
    ],
  },
  {
    id: "playback",
    title: "Playback (browser)",
    series: [
      { key: "playback_stats_events", label: "Playa stats events", color: "#60a5fa", unit: "count" },
      { key: "playback_stall_count", label: "Stalls", color: "#f87171", unit: "count" },
      { key: "playback_frames_rendered", label: "Frames rendered", color: "#4ade80", unit: "frames" },
      { key: "playback_bitrate_bps", label: "Playback bitrate", color: "#38bdf8", unit: "bps" },
      { key: "playback_hls_errors", label: "HLS errors", color: "#fb923c", unit: "count" },
      { key: "playback_hls_buffer_stalls", label: "HLS buffer stalls", color: "#ef4444", unit: "count" },
      { key: "playback_hls_frag_loads", label: "HLS fragments", color: "#a78bfa", unit: "count" },
      { key: "playback_video_time_sec", label: "Video time", color: "#c084fc", unit: "s" },
    ],
  },
];

function parseNumber(value: string | undefined): number {
  if (!value || value.trim() === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowMetric(row: Record<string, string>, key: string, legacyKey?: string): number {
  return parseNumber(row[key] ?? (legacyKey ? row[legacyKey] : undefined));
}

export function rowsToChartPoints(rows: Record<string, string>[]): ChartPoint[] {
  if (rows.length === 0) {
    return [];
  }

  const firstTimestamp = parseNumber(rows[0].timestamp);

  return rows.map((row, index) => {
    const timestamp = parseNumber(row.timestamp);
    const second =
      firstTimestamp > 0 && timestamp > 0
        ? Math.max(0, Math.round(timestamp - firstTimestamp))
        : index;

    return {
      second,
      encoded_bitrate_kbps: rowMetric(row, "encoded_bitrate_kbps", "bitrate_kbps"),
      fps: rowMetric(row, "fps"),
      fps_stability: rowMetric(row, "fps_stability"),
      speed: rowMetric(row, "speed"),
      cpu_percent: rowMetric(row, "cpu_percent"),
      memory_mb: rowMetric(row, "memory_mb"),
      transport_rtt_ms: rowMetric(row, "transport_rtt_ms", "rtt_ms"),
      transport_rtt_jitter_ms: rowMetric(row, "transport_rtt_jitter_ms", "rtt_jitter_ms"),
      pkt_rcv_drop: rowMetric(row, "pkt_rcv_drop"),
      pkt_snd_drop: rowMetric(row, "pkt_snd_drop"),
      pkt_snd_loss: rowMetric(row, "pkt_snd_loss"),
      pkt_retrans: rowMetric(row, "pkt_retrans"),
      pkt_fec_extra: rowMetric(row, "pkt_fec_extra"),
      ts_continuity_counter_errors: rowMetric(row, "ts_continuity_counter_errors", "cc_errors"),
      vmaf_score: rowMetric(row, "vmaf_score"),
      psnr_db: rowMetric(row, "psnr_db"),
      ssim: rowMetric(row, "ssim"),
      encoder_send_rate_mbps: rowMetric(row, "encoder_send_rate_mbps", "mbps_send_rate"),
      transport_recv_rate_mbps: rowMetric(row, "transport_recv_rate_mbps", "mbps_recv_rate"),
      client_memory_percent: rowMetric(row, "client_memory_percent"),
      client_disk_percent: rowMetric(row, "client_disk_percent"),
      server_cpu_percent: rowMetric(row, "server_cpu_percent"),
      server_memory_percent: rowMetric(row, "server_memory_percent"),
      server_disk_percent: rowMetric(row, "server_disk_percent"),
      moqx_subscribe_success: rowMetric(row, "moqx_subscribe_success"),
      moqx_subscribe_error: rowMetric(row, "moqx_subscribe_error"),
      moqx_publish_namespace_success: rowMetric(row, "moqx_publish_namespace_success"),
      moqx_publish_received: rowMetric(row, "moqx_publish_received"),
      moqx_publish_done: rowMetric(row, "moqx_publish_done"),
      quic_rtt_ms: rowMetric(row, "quic_rtt_ms"),
      quic_cwnd_bytes: rowMetric(row, "quic_cwnd_bytes"),
      quic_packets_lost: rowMetric(row, "quic_packets_lost"),
      playback_stats_events: rowMetric(row, "playback_stats_events"),
      playback_stall_count: rowMetric(row, "playback_stall_count"),
      playback_frames_rendered: rowMetric(row, "playback_frames_rendered"),
      playback_frames_dropped: rowMetric(row, "playback_frames_dropped"),
      playback_bitrate_bps: rowMetric(row, "playback_bitrate_bps"),
      playback_ttff_ms: rowMetric(row, "playback_ttff_ms"),
      playback_hls_errors: rowMetric(row, "playback_hls_errors"),
      playback_hls_fatal_errors: rowMetric(row, "playback_hls_fatal_errors"),
      playback_hls_buffer_stalls: rowMetric(row, "playback_hls_buffer_stalls"),
      playback_hls_frag_loads: rowMetric(row, "playback_hls_frag_loads"),
      playback_video_time_sec: rowMetric(row, "playback_video_time_sec"),
    };
  });
}

export function applyQualityScores(
  points: ChartPoint[],
  scores: { vmafScore?: number | null; psnrDb?: number | null; ssim?: number | null },
): ChartPoint[] {
  if (points.length === 0) {
    return points;
  }
  return points.map((point) => ({
    ...point,
    ...(scores.vmafScore != null && scores.vmafScore > 0 ? { vmaf_score: scores.vmafScore } : {}),
    ...(scores.psnrDb != null && scores.psnrDb > 0 ? { psnr_db: scores.psnrDb } : {}),
    ...(scores.ssim != null && scores.ssim > 0 ? { ssim: scores.ssim } : {}),
  }));
}

export function applyVmafScore(points: ChartPoint[], vmafScore?: number | null): ChartPoint[] {
  return applyQualityScores(points, { vmafScore });
}

export function samplesToChartPoints(samples: UploadSample[]): ChartPoint[] {
  return samples.map((sample) => ({
    second: sample.elapsed_sec,
    encoded_bitrate_kbps: sample.encoded_bitrate_kbps,
    fps: sample.fps,
    fps_stability: sample.fps_stability ?? 0,
    speed: sample.speed,
    cpu_percent: sample.cpu_percent,
    memory_mb: sample.memory_mb,
    transport_rtt_ms: sample.transport_rtt_ms ?? 0,
    transport_rtt_jitter_ms: sample.transport_rtt_jitter_ms ?? 0,
    pkt_rcv_drop: sample.pkt_rcv_drop ?? 0,
    pkt_snd_drop: sample.pkt_snd_drop ?? 0,
    pkt_snd_loss: sample.pkt_snd_loss ?? 0,
    pkt_retrans: sample.pkt_retrans ?? 0,
    pkt_fec_extra: sample.pkt_fec_extra ?? 0,
    ts_continuity_counter_errors: sample.ts_continuity_counter_errors ?? 0,
    vmaf_score: sample.vmaf_score ?? 0,
    psnr_db: sample.psnr_db ?? 0,
    ssim: sample.ssim ?? 0,
    encoder_send_rate_mbps: sample.encoder_send_rate_mbps ?? 0,
    transport_recv_rate_mbps: sample.transport_recv_rate_mbps ?? 0,
    client_memory_percent: sample.client_memory_percent ?? 0,
    client_disk_percent: sample.client_disk_percent ?? 0,
    server_cpu_percent: sample.server_cpu_percent ?? 0,
    server_memory_percent: sample.server_memory_percent ?? 0,
    server_disk_percent: sample.server_disk_percent ?? 0,
    moqx_subscribe_success: sample.moqx_subscribe_success ?? 0,
    moqx_subscribe_error: sample.moqx_subscribe_error ?? 0,
    moqx_publish_namespace_success: sample.moqx_publish_namespace_success ?? 0,
    moqx_publish_received: sample.moqx_publish_received ?? 0,
    moqx_publish_done: sample.moqx_publish_done ?? 0,
    quic_rtt_ms: sample.quic_rtt_ms ?? 0,
    quic_cwnd_bytes: sample.quic_cwnd_bytes ?? 0,
    quic_packets_lost: sample.quic_packets_lost ?? 0,
    playback_stats_events: sample.playback_stats_events ?? 0,
    playback_stall_count: sample.playback_stall_count ?? 0,
    playback_frames_rendered: sample.playback_frames_rendered ?? 0,
    playback_frames_dropped: sample.playback_frames_dropped ?? 0,
    playback_bitrate_bps: sample.playback_bitrate_bps ?? 0,
    playback_ttff_ms: sample.playback_ttff_ms ?? 0,
    playback_hls_errors: sample.playback_hls_errors ?? 0,
    playback_hls_fatal_errors: sample.playback_hls_fatal_errors ?? 0,
    playback_hls_buffer_stalls: sample.playback_hls_buffer_stalls ?? 0,
    playback_hls_frag_loads: sample.playback_hls_frag_loads ?? 0,
    playback_video_time_sec: sample.playback_video_time_sec ?? 0,
  }));
}

export function hasSeriesData(points: ChartPoint[], key: string): boolean {
  if (key === "vmaf_score") {
    return points.some((point) => point[key] > 0);
  }
  return points.some((point) => point[key] > 0);
}

export function visibleGroups(points: ChartPoint[], protocol: string): ChartGroup[] {
  return CHART_GROUPS.filter((group) => {
    if (group.id === "network" && protocol !== "srt") {
      return false;
    }
    if (group.id === "moqx" && protocol !== "moq") {
      return false;
    }
    if (group.id === "quic" && protocol !== "moq") {
      return false;
    }
    if (group.id === "playback") {
      return group.series.some((series) => hasSeriesData(points, series.key));
    }
    if (group.id === "quality") {
      return group.series.some((series) => hasSeriesData(points, series.key));
    }
    if (group.id === "server") {
      return group.series.some((series) => hasSeriesData(points, series.key));
    }
    return group.series.some((series) => hasSeriesData(points, series.key));
  });
}

export function resultToChartPoints(result: ResultSummary): ChartPoint[] {
  const points = rowsToChartPoints(result.rows);
  return applyQualityScores(points, {
    vmafScore: result.averages.vmaf_score,
    psnrDb: result.averages.psnr_db,
    ssim: result.averages.ssim,
  });
}

export function chartGroupById(id: string): ChartGroup | undefined {
  return CHART_GROUPS.find((group) => group.id === id);
}

export const ALL_CHART_METRIC_KEYS = [
  ...CHART_GROUPS.flatMap((group) => group.series.map((series) => series.key)),
  "vmaf_score",
  "psnr_db",
  "ssim",
] as const;

export interface SavedStreamData {
  id: string;
  label: string;
  protocol: string;
  result: ResultSummary;
  vmafScore?: number | null;
  psnrDb?: number | null;
  ssim?: number | null;
}

export function resultToSavedStream(result: ResultSummary, index: number): SavedStreamData {
  const endpoint = result.endpoint?.trim();
  const streamIndex = result.summary_extra?.stream_index;
  const streamNumber =
    typeof streamIndex === "number" && streamIndex >= 0 ? streamIndex + 1 : index + 1;
  const label = endpoint ? `Stream ${streamNumber} (${endpoint})` : `Stream ${streamNumber}`;
  return {
    id: result.filename,
    label,
    protocol: result.protocol,
    result,
    vmafScore: result.averages.vmaf_score,
    psnrDb: result.averages.psnr_db,
    ssim: result.averages.ssim,
  };
}

export function buildComparisonPointsFromResults(streams: SavedStreamData[]): ChartPoint[] {
  if (streams.length === 0) {
    return [];
  }

  const perStreamPoints = streams.map((stream) => resultToChartPoints(stream.result));
  const maxSecond = Math.max(0, ...perStreamPoints.flatMap((points) => points.map((point) => point.second)));
  const points: ChartPoint[] = [];

  for (let second = 0; second <= maxSecond; second += 1) {
    const point: ChartPoint = { second };
    perStreamPoints.forEach((streamPoints, index) => {
      const sample = streamPoints.find((item) => item.second === second);
      if (!sample) {
        return;
      }
      const suffix = `_${index}`;
      for (const key of ALL_CHART_METRIC_KEYS) {
        const value = sample[key];
        if (typeof value === "number" && value > 0) {
          point[`${key}${suffix}`] = value;
        }
      }
      const stream = streams[index];
      if (stream.vmafScore != null && stream.vmafScore > 0) {
        point[`vmaf_score${suffix}`] = stream.vmafScore;
      }
      if (stream.psnrDb != null && stream.psnrDb > 0) {
        point[`psnr_db${suffix}`] = stream.psnrDb;
      }
      if (stream.ssim != null && stream.ssim > 0) {
        point[`ssim${suffix}`] = stream.ssim;
      }
    });
    points.push(point);
  }

  return points;
}

export function savedStreamsToLegs(streams: SavedStreamData[]): ComparisonLegData[] {
  return streams.map((stream) => ({
    id: stream.id,
    label: stream.label,
    protocol: stream.protocol,
    samples: [],
    vmafScore: stream.vmafScore,
    psnrDb: stream.psnrDb,
    ssim: stream.ssim,
  }));
}

export const LEG_COLORS = ["#22d3ee", "#fb923c", "#a78bfa", "#4ade80", "#f472b6"];

const SAMPLE_METRIC_KEYS = [
  "encoded_bitrate_kbps",
  "fps",
  "fps_stability",
  "speed",
  "cpu_percent",
  "memory_mb",
  "client_memory_percent",
  "client_disk_percent",
  "server_cpu_percent",
  "server_memory_percent",
  "server_disk_percent",
  "encoder_send_rate_mbps",
  "transport_recv_rate_mbps",
  "transport_rtt_ms",
  "transport_rtt_jitter_ms",
  "pkt_rcv_drop",
  "pkt_snd_drop",
  "pkt_retrans",
  "pkt_fec_extra",
  "ts_continuity_counter_errors",
  "moqx_subscribe_success",
  "moqx_subscribe_error",
  "moqx_publish_namespace_success",
  "moqx_publish_received",
  "moqx_publish_done",
  "quic_rtt_ms",
  "quic_cwnd_bytes",
  "quic_packets_lost",
  "playback_stats_events",
  "playback_stall_count",
  "playback_frames_rendered",
  "playback_frames_dropped",
  "playback_bitrate_bps",
  "playback_ttff_ms",
  "playback_hls_errors",
  "playback_hls_fatal_errors",
  "playback_hls_buffer_stalls",
  "playback_hls_frag_loads",
  "playback_video_time_sec",
] as const;

export interface ComparisonLegData {
  id: string;
  label: string;
  protocol: string;
  samples: UploadSample[];
  vmafScore?: number | null;
  psnrDb?: number | null;
  ssim?: number | null;
}

function sampleValue(sample: UploadSample, key: (typeof SAMPLE_METRIC_KEYS)[number]): number {
  const value = sample[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildComparisonPoints(legs: ComparisonLegData[]): ChartPoint[] {
  if (legs.length === 0) {
    return [];
  }

  const maxSecond = Math.max(
    0,
    ...legs.flatMap((leg) => leg.samples.map((sample) => sample.elapsed_sec)),
  );

  const points: ChartPoint[] = [];
  for (let second = 0; second <= maxSecond; second += 1) {
    const point: ChartPoint = { second };
    legs.forEach((leg, index) => {
      const sample = leg.samples.find((item) => item.elapsed_sec === second);
      if (!sample) {
        return;
      }
      const suffix = `_${index}`;
      for (const key of SAMPLE_METRIC_KEYS) {
        point[`${key}${suffix}`] = sampleValue(sample, key);
      }
      if (leg.vmafScore != null && leg.vmafScore > 0) {
        point[`vmaf_score${suffix}`] = leg.vmafScore;
      }
      if (leg.psnrDb != null && leg.psnrDb > 0) {
        point[`psnr_db${suffix}`] = leg.psnrDb;
      }
      if (leg.ssim != null && leg.ssim > 0) {
        point[`ssim${suffix}`] = leg.ssim;
      }
    });
    points.push(point);
  }
  return points;
}

export function comparisonSeries(
  legs: ComparisonLegData[],
  metric: string,
  unit?: string,
): ChartSeries[] {
  return legs.map((leg, index) => ({
    key: `${metric}_${index}`,
    label: leg.label,
    color: LEG_COLORS[index % LEG_COLORS.length],
    unit,
  }));
}

export function comparisonHasMetric(points: ChartPoint[], metric: string, legCount: number): boolean {
  for (let index = 0; index < legCount; index += 1) {
    const key = `${metric}_${index}`;
    if (points.some((point) => (point[key] ?? 0) > 0)) {
      return true;
    }
  }
  return false;
}

export function comparisonVisibleGroups(
  points: ChartPoint[],
  legs: ComparisonLegData[],
): Array<{ id: string; title: string }> {
  const hasSrt = legs.some((leg) => leg.protocol === "srt");
  const groups: Array<{ id: string; title: string }> = [
    { id: "encode", title: "Encode & throughput" },
  ];
  if (hasSrt && comparisonHasMetric(points, "transport_rtt_ms", legs.length)) {
    groups.push({ id: "network", title: "Network (SRT)" });
  }
  const hasMoq = legs.some((leg) => leg.protocol === "moq");
  if (hasMoq && comparisonHasMetric(points, "moqx_subscribe_success", legs.length)) {
    groups.push({ id: "moqx", title: "Network (MoQ relay)" });
  }
  if (hasMoq && comparisonHasMetric(points, "quic_rtt_ms", legs.length)) {
    groups.push({ id: "quic", title: "Network (QUIC / picoquic)" });
  }
  if (comparisonHasMetric(points, "cpu_percent", legs.length)) {
    groups.push({ id: "system", title: "Client (ffmpeg host)" });
  }
  if (comparisonHasMetric(points, "server_cpu_percent", legs.length)) {
    groups.push({ id: "server", title: "Server (ingest / relay host)" });
  }
  if (comparisonHasMetric(points, "encoder_send_rate_mbps", legs.length)) {
    groups.push({ id: "bandwidth", title: "Bandwidth" });
  }
  if (
    comparisonHasMetric(points, "vmaf_score", legs.length) ||
    comparisonHasMetric(points, "psnr_db", legs.length) ||
    comparisonHasMetric(points, "ssim", legs.length)
  ) {
    groups.push({ id: "quality", title: "Quality (post-ingest)" });
  }
  if (
    comparisonHasMetric(points, "playback_stats_events", legs.length) ||
    comparisonHasMetric(points, "playback_hls_errors", legs.length) ||
    comparisonHasMetric(points, "playback_stall_count", legs.length) ||
    comparisonHasMetric(points, "playback_video_time_sec", legs.length)
  ) {
    groups.push({ id: "playback", title: "Playback (browser)" });
  }
  return groups;
}
