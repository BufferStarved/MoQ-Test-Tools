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
    title: "Encode",
    series: [
      { key: "encoded_bitrate_kbps", label: "Encoded bitrate", color: "#22d3ee", unit: "kbps" },
      { key: "fps", label: "Frame rate", color: "#4ade80", unit: "fps" },
      { key: "encode_lag_ms", label: "Encode lag", color: "#fbbf24", unit: "ms" },
      { key: "fps_stability", label: "FPS stability", color: "#a3e635", unit: "cv" },
      { key: "speed", label: "Speed", color: "#38bdf8", unit: "x" },
    ],
  },
  {
    id: "transport",
    title: "Network transport",
    series: [
      { key: "net_rtt_ms", label: "RTT (net)", color: "#fbbf24", unit: "ms" },
      { key: "net_jitter_ms", label: "Jitter (net)", color: "#fb923c", unit: "ms" },
      { key: "net_send_mbps", label: "Send rate (net)", color: "#38bdf8", unit: "Mbps" },
      { key: "net_recv_mbps", label: "Receive rate (net)", color: "#818cf8", unit: "Mbps" },
      { key: "net_loss_pct", label: "Loss %", color: "#f87171", unit: "%" },
      { key: "net_retrans_pct", label: "Retransmit %", color: "#ef4444", unit: "%" },
    ],
  },
  {
    id: "client",
    title: "Client",
    series: [
      { key: "cpu_percent", label: "Process CPU", color: "#a78bfa", unit: "%" },
      { key: "memory_mb", label: "Process memory", color: "#f472b6", unit: "MB" },
      { key: "client_memory_percent", label: "Host memory", color: "#c084fc", unit: "%" },
      { key: "client_disk_percent", label: "Host disk", color: "#e879f9", unit: "%" },
    ],
  },
  {
    id: "ingest",
    title: "Ingest",
    series: [
      // Normalized (all protocols): host health + path recovery
      { key: "server_cpu_percent", label: "Ingest host CPU", color: "#60a5fa", unit: "%" },
      { key: "server_memory_percent", label: "Ingest host memory", color: "#34d399", unit: "%" },
      { key: "server_disk_percent", label: "Ingest host disk", color: "#fbbf24", unit: "%" },
      { key: "net_loss_pct", label: "Path loss %", color: "#f87171", unit: "%" },
      { key: "net_retrans_pct", label: "Path retransmit %", color: "#ef4444", unit: "%" },
      // Protocol detail — MoQ relay
      { key: "moqx_subscribe_success", label: "MoQ subscribe OK (Δ)", color: "#60a5fa", unit: "count" },
      { key: "moqx_subscribe_error", label: "MoQ subscribe errors (Δ)", color: "#f87171", unit: "count" },
      { key: "moqx_publish_received", label: "MoQ objects received (Δ)", color: "#a3e635", unit: "count" },
      { key: "moqx_publish_namespace_success", label: "MoQ publish OK (Δ)", color: "#4ade80", unit: "count" },
      { key: "quic_cwnd_bytes", label: "QUIC cwnd", color: "#818cf8", unit: "bytes" },
      // Protocol detail — SRT / Zixi edge
      { key: "pkt_retrans", label: "SRT retransmits", color: "#f87171", unit: "pkts" },
      { key: "pkt_fec_extra", label: "FEC extra", color: "#c084fc", unit: "pkts" },
      { key: "pkt_snd_loss", label: "Send loss", color: "#ef4444", unit: "pkts" },
    ],
  },
  {
    id: "media_health",
    title: "Media Health",
    series: [
      {
        key: "ts_continuity_counter_errors",
        label: "TS continuity errors",
        color: "#e879f9",
        unit: "count",
      },
      { key: "cmaf_seq_gap_count", label: "CMAF sequence gaps", color: "#f472b6", unit: "count" },
      { key: "cmaf_tfdt_gap_count", label: "CMAF decode-time gaps", color: "#fb923c", unit: "count" },
      { key: "cmaf_tfdt_gap_ms", label: "CMAF decode-time gap", color: "#fbbf24", unit: "ms" },
      { key: "cmaf_tfdt_overlap_count", label: "CMAF timeline overlaps", color: "#a78bfa", unit: "count" },
      { key: "cmaf_parse_errors", label: "CMAF parse errors", color: "#ef4444", unit: "count" },
    ],
  },
  {
    id: "video_quality",
    title: "Video Quality",
    series: [
      { key: "vmaf_score", label: "VMAF", color: "#34d399", unit: "score" },
      { key: "psnr_db", label: "PSNR", color: "#2dd4bf", unit: "dB" },
      { key: "ssim", label: "SSIM", color: "#22d3ee", unit: "score" },
    ],
  },
  {
    id: "playback",
    title: "Browser playback",
    series: [
      { key: "e2e_latency_ms", label: "E2E latency (est.)", color: "#f472b6", unit: "ms" },
      { key: "playback_ttff_ms", label: "Time to first frame", color: "#22d3ee", unit: "ms" },
      { key: "playback_stall_count", label: "Stalls", color: "#f87171", unit: "count" },
      { key: "playback_buffer_sec", label: "Buffer duration", color: "#a78bfa", unit: "s" },
      { key: "playback_bitrate_bps", label: "Playback bitrate", color: "#38bdf8", unit: "bps" },
      { key: "playback_frames_rendered", label: "Frames rendered", color: "#4ade80", unit: "frames" },
      { key: "playback_frames_dropped", label: "Frames dropped", color: "#fb923c", unit: "frames" },
      { key: "playback_error_count", label: "Player errors", color: "#ef4444", unit: "count" },
      { key: "playback_video_time_sec", label: "Video time", color: "#c084fc", unit: "s" },
    ],
  },
];

/** @deprecated Use id transport / client / ingest / video_quality */
export const LEGACY_CHART_GROUP_ALIASES: Record<string, string> = {
  network: "transport",
  bandwidth: "transport",
  system: "client",
  server: "ingest",
  quic: "ingest",
  moqx: "ingest",
  edge_relay: "ingest",
  edge_zixi: "ingest",
  quality: "video_quality",
};

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

    const transportRtt = rowMetric(row, "transport_rtt_ms", "rtt_ms");
    const transportJitter = rowMetric(row, "transport_rtt_jitter_ms", "rtt_jitter_ms");
    const quicRtt = rowMetric(row, "quic_rtt_ms");
    const sendMbps = rowMetric(row, "encoder_send_rate_mbps", "mbps_send_rate");
    const recvMbps = rowMetric(row, "transport_recv_rate_mbps", "mbps_recv_rate");
    const hlsErrors = rowMetric(row, "playback_hls_errors");
    const hlsFatal = rowMetric(row, "playback_hls_fatal_errors");

    return {
      second,
      encoded_bitrate_kbps: rowMetric(row, "encoded_bitrate_kbps", "bitrate_kbps"),
      fps: rowMetric(row, "fps"),
      fps_stability: rowMetric(row, "fps_stability"),
      speed: rowMetric(row, "speed"),
      encode_lag_ms: rowMetric(row, "encode_lag_ms"),
      cpu_percent: rowMetric(row, "cpu_percent"),
      memory_mb: rowMetric(row, "memory_mb"),
      transport_rtt_ms: transportRtt,
      transport_rtt_jitter_ms: transportJitter,
      net_rtt_ms: rowMetric(row, "net_rtt_ms") || transportRtt || quicRtt,
      net_jitter_ms: rowMetric(row, "net_jitter_ms") || transportJitter,
      net_send_mbps: rowMetric(row, "net_send_mbps") || sendMbps,
      net_recv_mbps: rowMetric(row, "net_recv_mbps") || recvMbps,
      net_loss_pct: rowMetric(row, "net_loss_pct"),
      net_retrans_pct: rowMetric(row, "net_retrans_pct"),
      pkt_rcv_drop: rowMetric(row, "pkt_rcv_drop"),
      pkt_snd_drop: rowMetric(row, "pkt_snd_drop"),
      pkt_snd_loss: rowMetric(row, "pkt_snd_loss"),
      pkt_retrans: rowMetric(row, "pkt_retrans"),
      pkt_fec_extra: rowMetric(row, "pkt_fec_extra"),
      ts_continuity_counter_errors: rowMetric(row, "ts_continuity_counter_errors", "cc_errors"),
      cmaf_fragment_count: rowMetric(row, "cmaf_fragment_count"),
      cmaf_seq_gap_count: rowMetric(row, "cmaf_seq_gap_count"),
      cmaf_tfdt_gap_count: rowMetric(row, "cmaf_tfdt_gap_count"),
      cmaf_tfdt_gap_ms: rowMetric(row, "cmaf_tfdt_gap_ms"),
      cmaf_tfdt_overlap_count: rowMetric(row, "cmaf_tfdt_overlap_count"),
      cmaf_parse_errors: rowMetric(row, "cmaf_parse_errors"),
      vmaf_score: rowMetric(row, "vmaf_score"),
      psnr_db: rowMetric(row, "psnr_db"),
      ssim: rowMetric(row, "ssim"),
      encoder_send_rate_mbps: sendMbps,
      transport_recv_rate_mbps: recvMbps,
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
      quic_rtt_ms: quicRtt,
      quic_cwnd_bytes: rowMetric(row, "quic_cwnd_bytes"),
      quic_packets_lost: rowMetric(row, "quic_packets_lost"),
      playback_stats_events: rowMetric(row, "playback_stats_events"),
      playback_stall_count: rowMetric(row, "playback_stall_count"),
      playback_frames_rendered: rowMetric(row, "playback_frames_rendered"),
      playback_frames_dropped: rowMetric(row, "playback_frames_dropped"),
      playback_bitrate_bps: rowMetric(row, "playback_bitrate_bps"),
      playback_ttff_ms: rowMetric(row, "playback_ttff_ms"),
      playback_hls_errors: hlsErrors,
      playback_hls_fatal_errors: hlsFatal,
      playback_hls_buffer_stalls: rowMetric(row, "playback_hls_buffer_stalls"),
      playback_hls_frag_loads: rowMetric(row, "playback_hls_frag_loads"),
      playback_video_time_sec: rowMetric(row, "playback_video_time_sec"),
      playback_buffer_sec: rowMetric(row, "playback_buffer_sec"),
      playback_error_count: rowMetric(row, "playback_error_count") || hlsErrors + hlsFatal,
      e2e_latency_ms: rowMetric(row, "e2e_latency_ms"),
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

/** Paint summary CMAF Media Health totals onto chart points when CSV rows are empty. */
export function applyMediaHealthScores(
  points: ChartPoint[],
  scores: {
    cmaf_seq_gap_count?: number | null;
    cmaf_tfdt_gap_count?: number | null;
    cmaf_tfdt_gap_ms?: number | null;
    cmaf_tfdt_overlap_count?: number | null;
    cmaf_parse_errors?: number | null;
    cmaf_fragment_count?: number | null;
  },
): ChartPoint[] {
  if (points.length === 0) {
    return points;
  }
  const hasAny = Object.values(scores).some((value) => value != null && value > 0);
  if (!hasAny) {
    return points;
  }
  return points.map((point) => ({
    ...point,
    ...(scores.cmaf_seq_gap_count != null ? { cmaf_seq_gap_count: scores.cmaf_seq_gap_count } : {}),
    ...(scores.cmaf_tfdt_gap_count != null ? { cmaf_tfdt_gap_count: scores.cmaf_tfdt_gap_count } : {}),
    ...(scores.cmaf_tfdt_gap_ms != null ? { cmaf_tfdt_gap_ms: scores.cmaf_tfdt_gap_ms } : {}),
    ...(scores.cmaf_tfdt_overlap_count != null
      ? { cmaf_tfdt_overlap_count: scores.cmaf_tfdt_overlap_count }
      : {}),
    ...(scores.cmaf_parse_errors != null ? { cmaf_parse_errors: scores.cmaf_parse_errors } : {}),
    ...(scores.cmaf_fragment_count != null ? { cmaf_fragment_count: scores.cmaf_fragment_count } : {}),
  }));
}

export function applyVmafScore(points: ChartPoint[], vmafScore?: number | null): ChartPoint[] {
  return applyQualityScores(points, { vmafScore });
}

/** Prefer summary averages, then ingest quality leg, then encoder leg. */
export function qualityScoresFromResult(result: ResultSummary): {
  vmafScore?: number | null;
  psnrDb?: number | null;
  ssim?: number | null;
} {
  const ingest = result.quality?.ingest;
  const encoder = result.quality?.encoder;
  const pick = (...values: Array<number | null | undefined>) => {
    for (const value of values) {
      if (value != null && value > 0) {
        return value;
      }
    }
    return null;
  };
  return {
    vmafScore: pick(result.averages.vmaf_score, ingest?.vmaf_score, encoder?.vmaf_score),
    psnrDb: pick(result.averages.psnr_db, ingest?.psnr_db, encoder?.psnr_db),
    ssim: pick(result.averages.ssim, ingest?.ssim, encoder?.ssim),
  };
}

function normalizeSamplePoint(sample: UploadSample, moqxBase?: UploadSample | null): ChartPoint {
  const sendMbps = sample.encoder_send_rate_mbps ?? sample.encoded_bitrate_kbps / 1000;
  const rtt = sample.net_rtt_ms ?? sample.transport_rtt_ms ?? sample.quic_rtt_ms ?? 0;
  const jitter = sample.net_jitter_ms ?? sample.transport_rtt_jitter_ms ?? 0;
  const recvMbps = sample.net_recv_mbps ?? sample.transport_recv_rate_mbps ?? 0;
  const sndLoss = sample.pkt_snd_loss ?? 0;
  const retrans = sample.pkt_retrans ?? 0;
  const fec = sample.pkt_fec_extra ?? 0;
  const quicLost = sample.quic_packets_lost ?? 0;
  // Rough normalization: loss% / retrans% vs send rate when SRT counters exist.
  const sentPktsProxy = Math.max(sndLoss + retrans + 1, sample.elapsed_sec * 100);
  const netLossPct =
    sample.net_loss_pct ??
    (sndLoss > 0 || quicLost > 0
      ? Math.min(100, ((sndLoss + quicLost) / sentPktsProxy) * 100)
      : 0);
  const netRetransPct =
    sample.net_retrans_pct ?? (retrans > 0 ? Math.min(100, (retrans / sentPktsProxy) * 100) : 0);

  const baseSub = moqxBase?.moqx_subscribe_success ?? 0;
  const baseErr = moqxBase?.moqx_subscribe_error ?? 0;
  const basePub = moqxBase?.moqx_publish_received ?? 0;
  const baseNs = moqxBase?.moqx_publish_namespace_success ?? 0;

  const hlsErrors = sample.playback_hls_errors ?? 0;
  const hlsFatal = sample.playback_hls_fatal_errors ?? 0;

  return {
    second: sample.elapsed_sec,
    encoded_bitrate_kbps: sample.encoded_bitrate_kbps,
    fps: sample.fps,
    fps_stability: sample.fps_stability ?? 0,
    speed: sample.speed,
    encode_lag_ms: sample.encode_lag_ms ?? 0,
    cpu_percent: sample.cpu_percent,
    memory_mb: sample.memory_mb,
    net_rtt_ms: rtt,
    net_jitter_ms: jitter,
    net_send_mbps: sample.net_send_mbps ?? sendMbps,
    net_recv_mbps: recvMbps,
    net_loss_pct: netLossPct,
    net_retrans_pct: netRetransPct,
    transport_rtt_ms: sample.transport_rtt_ms ?? 0,
    transport_rtt_jitter_ms: sample.transport_rtt_jitter_ms ?? 0,
    pkt_rcv_drop: sample.pkt_rcv_drop ?? 0,
    pkt_snd_drop: sample.pkt_snd_drop ?? 0,
    pkt_snd_loss: sndLoss,
    pkt_retrans: retrans,
    pkt_fec_extra: fec,
    ts_continuity_counter_errors: sample.ts_continuity_counter_errors ?? 0,
    cmaf_fragment_count: sample.cmaf_fragment_count ?? 0,
    cmaf_seq_gap_count: sample.cmaf_seq_gap_count ?? 0,
    cmaf_tfdt_gap_count: sample.cmaf_tfdt_gap_count ?? 0,
    cmaf_tfdt_gap_ms: sample.cmaf_tfdt_gap_ms ?? 0,
    cmaf_tfdt_overlap_count: sample.cmaf_tfdt_overlap_count ?? 0,
    cmaf_parse_errors: sample.cmaf_parse_errors ?? 0,
    vmaf_score: sample.vmaf_score ?? 0,
    psnr_db: sample.psnr_db ?? 0,
    ssim: sample.ssim ?? 0,
    encoder_send_rate_mbps: sendMbps,
    transport_recv_rate_mbps: recvMbps,
    client_memory_percent: sample.client_memory_percent ?? 0,
    client_disk_percent: sample.client_disk_percent ?? 0,
    server_cpu_percent: sample.server_cpu_percent ?? 0,
    server_memory_percent: sample.server_memory_percent ?? 0,
    server_disk_percent: sample.server_disk_percent ?? 0,
    moqx_subscribe_success: Math.max(0, (sample.moqx_subscribe_success ?? 0) - baseSub),
    moqx_subscribe_error: Math.max(0, (sample.moqx_subscribe_error ?? 0) - baseErr),
    moqx_publish_namespace_success: Math.max(
      0,
      (sample.moqx_publish_namespace_success ?? 0) - baseNs,
    ),
    moqx_publish_received: Math.max(0, (sample.moqx_publish_received ?? 0) - basePub),
    moqx_publish_done: sample.moqx_publish_done ?? 0,
    quic_rtt_ms: sample.quic_rtt_ms ?? 0,
    quic_cwnd_bytes: sample.quic_cwnd_bytes ?? 0,
    quic_packets_lost: quicLost,
    playback_stall_count: sample.playback_stall_count ?? 0,
    playback_frames_rendered: sample.playback_frames_rendered ?? 0,
    playback_frames_dropped: sample.playback_frames_dropped ?? 0,
    playback_bitrate_bps: sample.playback_bitrate_bps ?? 0,
    playback_ttff_ms: sample.playback_ttff_ms ?? 0,
    playback_error_count: sample.playback_error_count ?? hlsErrors + hlsFatal,
    playback_video_time_sec: sample.playback_video_time_sec ?? 0,
    playback_buffer_sec: sample.playback_buffer_sec ?? 0,
    e2e_latency_ms: sample.e2e_latency_ms ?? 0,
  };
}

export function samplesToChartPoints(samples: UploadSample[]): ChartPoint[] {
  const base = samples[0] ?? null;
  return samples.map((sample) => normalizeSamplePoint(sample, base));
}

export function hasSeriesData(points: ChartPoint[], key: string): boolean {
  if (key === "vmaf_score") {
    return points.some((point) => point[key] > 0);
  }
  return points.some((point) => point[key] > 0);
}

export function visibleGroups(points: ChartPoint[], protocol: string): ChartGroup[] {
  const proto = (protocol || "").toLowerCase();
  return CHART_GROUPS.filter((group) => {
    if (group.id === "ingest") {
      // Host health + path recovery are normalized; protocol panels may be all-zero
      // (clean SRT) so still surface the tab when we have samples for that path.
      return (
        points.length > 0 &&
        (hasSeriesData(points, "server_cpu_percent") ||
          hasSeriesData(points, "server_memory_percent") ||
          hasSeriesData(points, "net_loss_pct") ||
          hasSeriesData(points, "net_retrans_pct") ||
          hasSeriesData(points, "moqx_subscribe_success") ||
          hasSeriesData(points, "moqx_publish_received") ||
          hasSeriesData(points, "quic_cwnd_bytes") ||
          proto === "moq" ||
          proto === "srt" ||
          proto === "rtmp")
      );
    }
    if (group.id === "media_health") {
      return (
        hasSeriesData(points, "ts_continuity_counter_errors") ||
        hasSeriesData(points, "cmaf_fragment_count") ||
        hasSeriesData(points, "cmaf_seq_gap_count") ||
        hasSeriesData(points, "cmaf_tfdt_gap_count") ||
        hasSeriesData(points, "cmaf_parse_errors")
      );
    }
    if (group.id === "playback" || group.id === "video_quality") {
      return group.series.some((series) => hasSeriesData(points, series.key));
    }
    return group.series.some((series) => hasSeriesData(points, series.key));
  });
}

export function resultToChartPoints(result: ResultSummary): ChartPoint[] {
  const points = applyQualityScores(rowsToChartPoints(result.rows), qualityScoresFromResult(result));
  return applyMediaHealthScores(points, {
    cmaf_seq_gap_count: result.averages.cmaf_seq_gap_count,
    cmaf_tfdt_gap_count: result.averages.cmaf_tfdt_gap_count,
    cmaf_tfdt_gap_ms: result.averages.cmaf_tfdt_gap_ms,
    cmaf_tfdt_overlap_count: result.averages.cmaf_tfdt_overlap_count,
    cmaf_parse_errors: result.averages.cmaf_parse_errors,
    cmaf_fragment_count: result.averages.cmaf_fragment_count,
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
  const scores = qualityScoresFromResult(result);
  return {
    id: result.filename,
    label,
    protocol: result.protocol,
    result,
    vmafScore: scores.vmafScore,
    psnrDb: scores.psnrDb,
    ssim: scores.ssim,
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

const COMPARISON_METRIC_KEYS = [
  "encoded_bitrate_kbps",
  "fps",
  "fps_stability",
  "speed",
  "encode_lag_ms",
  "cpu_percent",
  "memory_mb",
  "client_memory_percent",
  "client_disk_percent",
  "server_cpu_percent",
  "server_memory_percent",
  "server_disk_percent",
  "net_rtt_ms",
  "net_jitter_ms",
  "net_send_mbps",
  "net_recv_mbps",
  "net_loss_pct",
  "net_retrans_pct",
  "pkt_retrans",
  "pkt_fec_extra",
  "pkt_snd_loss",
  "ts_continuity_counter_errors",
  "cmaf_seq_gap_count",
  "cmaf_tfdt_gap_count",
  "cmaf_tfdt_gap_ms",
  "cmaf_tfdt_overlap_count",
  "cmaf_parse_errors",
  "cmaf_fragment_count",
  "moqx_subscribe_success",
  "moqx_subscribe_error",
  "moqx_publish_namespace_success",
  "moqx_publish_received",
  "quic_rtt_ms",
  "quic_cwnd_bytes",
  "quic_packets_lost",
  "playback_stall_count",
  "playback_frames_rendered",
  "playback_frames_dropped",
  "playback_bitrate_bps",
  "playback_ttff_ms",
  "playback_error_count",
  "playback_video_time_sec",
  "playback_buffer_sec",
  "e2e_latency_ms",
  "vmaf_score",
  "psnr_db",
  "ssim",
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

export function buildComparisonPoints(legs: ComparisonLegData[]): ChartPoint[] {
  if (legs.length === 0) {
    return [];
  }

  const normalizedLegs = legs.map((leg) => ({
    ...leg,
    points: samplesToChartPoints(leg.samples),
  }));

  const maxSecond = Math.max(
    0,
    ...normalizedLegs.flatMap((leg) => leg.points.map((point) => point.second)),
  );

  const points: ChartPoint[] = [];
  for (let second = 0; second <= maxSecond; second += 1) {
    const point: ChartPoint = { second };
    normalizedLegs.forEach((leg, index) => {
      const samplePoint = leg.points.find((item) => item.second === second);
      if (!samplePoint) {
        return;
      }
      const suffix = `_${index}`;
      for (const key of COMPARISON_METRIC_KEYS) {
        point[`${key}${suffix}`] = samplePoint[key] ?? 0;
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

/** True when any leg has the key present (including flat zeros). */
export function comparisonHasMetricPresent(
  points: ChartPoint[],
  metric: string,
  legCount: number,
): boolean {
  for (let index = 0; index < legCount; index += 1) {
    const key = `${metric}_${index}`;
    if (points.some((point) => Object.prototype.hasOwnProperty.call(point, key))) {
      return true;
    }
  }
  return false;
}

export function comparisonVisibleGroups(
  points: ChartPoint[],
  legs: ComparisonLegData[],
): Array<{ id: string; title: string }> {
  const hasSrtOrRtmp = legs.some((leg) => leg.protocol === "srt" || leg.protocol === "rtmp");
  const hasMoq = legs.some((leg) => leg.protocol === "moq");
  const groups: Array<{ id: string; title: string }> = [{ id: "encode", title: "Encode" }];

  if (
    comparisonHasMetric(points, "net_rtt_ms", legs.length) ||
    comparisonHasMetric(points, "net_send_mbps", legs.length)
  ) {
    groups.push({ id: "transport", title: "Network transport" });
  }
  if (comparisonHasMetric(points, "cpu_percent", legs.length)) {
    groups.push({ id: "client", title: "Client" });
  }
  if (
    comparisonHasMetric(points, "server_cpu_percent", legs.length) ||
    hasMoq ||
    hasSrtOrRtmp
  ) {
    groups.push({ id: "ingest", title: "Ingest" });
  }
  if (
    comparisonHasMetric(points, "ts_continuity_counter_errors", legs.length) ||
    comparisonHasMetric(points, "cmaf_fragment_count", legs.length) ||
    comparisonHasMetric(points, "cmaf_seq_gap_count", legs.length) ||
    comparisonHasMetric(points, "cmaf_tfdt_gap_count", legs.length) ||
    comparisonHasMetric(points, "cmaf_parse_errors", legs.length)
  ) {
    groups.push({ id: "media_health", title: "Media Health" });
  }
  if (
    comparisonHasMetric(points, "vmaf_score", legs.length) ||
    comparisonHasMetric(points, "psnr_db", legs.length) ||
    comparisonHasMetric(points, "ssim", legs.length)
  ) {
    groups.push({ id: "video_quality", title: "Video Quality" });
  }
  if (
    comparisonHasMetric(points, "e2e_latency_ms", legs.length) ||
    comparisonHasMetricPresent(points, "playback_stall_count", legs.length) ||
    comparisonHasMetric(points, "playback_ttff_ms", legs.length) ||
    comparisonHasMetric(points, "playback_video_time_sec", legs.length)
  ) {
    groups.push({ id: "playback", title: "Browser playback" });
  }
  return groups;
}
