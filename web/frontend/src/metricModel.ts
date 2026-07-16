/**
 * Normalized metrics taxonomy for cross-protocol comparison.
 *
 * Chart/compare only metrics with a stable meaning. Protocol-native counters
 * (SRT pkt_*, Zixi TR101, moqx Prometheus) live in edge panels and show
 * "Not available with protocol X" when the active leg cannot provide them.
 */

export type MetricStageId =
  | "metadata"
  | "client"
  | "encode"
  | "video_quality"
  | "transport"
  | "server"
  | "edge_relay"
  | "edge_zixi"
  | "media_health"
  | "playback";

export type ProtocolId = "srt" | "rtmp" | "http" | "hls" | "dash" | "webrtc" | "moq" | string;

export interface MetricStage {
  id: MetricStageId;
  title: string;
  description: string;
}

export const METRIC_STAGES: MetricStage[] = [
  {
    id: "metadata",
    title: "Run metadata",
    description: "Job identity (protocol, endpoint, sample count). Not charted as a time series.",
  },
  {
    id: "client",
    title: "Client",
    description: "Publisher host running ffmpeg / openmoq-publisher.",
  },
  {
    id: "encode",
    title: "Encode",
    description: "Encoder output before the network path.",
  },
  {
    id: "video_quality",
    title: "Video Quality",
    description: "VMAF / PSNR / SSIM on encoder output and/or ingest recording.",
  },
  {
    id: "transport",
    title: "Network transport",
    description: "Normalized net_* fields filled from SRT, QUIC, or best-effort proxies.",
  },
  {
    id: "server",
    title: "Server",
    description: "Ingest or relay VM health (agent and/or GCP Monitoring).",
  },
  {
    id: "edge_relay",
    title: "Relay health (MoQ)",
    description: "moqx Prometheus counters as job-window deltas — not absolute since restart.",
  },
  {
    id: "edge_zixi",
    title: "Edge (Zixi)",
    description: "Zixi/SRT recovery counters (retransmits, FEC) — transport recovery, not Media Health.",
  },
  {
    id: "media_health",
    title: "Media Health",
    description:
      "Container/timeline integrity at the media layer. MPEG-TS: Zixi TR101 continuity. MoQ CMAF: fragment sequence + decode-time gaps. Not transport metrics.",
  },
  {
    id: "playback",
    title: "Browser playback",
    description: "Viewer experience: TTFF, stalls, bitrate, end-to-end latency estimate.",
  },
];

/** Protocols that can populate a metric (empty = never / metadata-only). */
export const METRIC_PROTOCOL_SUPPORT: Record<string, ProtocolId[]> = {
  // Client + encode — all publish paths
  cpu_percent: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  memory_mb: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  client_memory_percent: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  client_disk_percent: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encoded_bitrate_kbps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  fps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  fps_stability: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  speed: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encode_lag_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encoder_send_rate_mbps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],

  // Normalized transport
  net_rtt_ms: ["srt", "moq"],
  net_jitter_ms: ["srt"],
  net_send_mbps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  net_recv_mbps: ["srt"],
  net_loss_pct: ["srt", "moq"],
  net_retrans_pct: ["srt"],
  net_fec_pct: ["srt"],

  // Legacy aliases (same support as normalized)
  transport_rtt_ms: ["srt", "moq"],
  transport_rtt_jitter_ms: ["srt"],
  transport_recv_rate_mbps: ["srt"],
  quic_rtt_ms: ["moq"],
  quic_cwnd_bytes: ["moq"],
  quic_packets_lost: ["moq"],
  pkt_rcv_drop: ["srt"],
  pkt_snd_drop: ["srt"],

  // Server
  server_cpu_percent: ["srt", "rtmp", "http", "hls", "dash", "moq"],
  server_memory_percent: ["srt", "rtmp", "http", "hls", "dash", "moq"],
  server_disk_percent: ["srt", "rtmp", "http", "hls", "dash", "moq"],

  // Edge transport recovery (Zixi/SRT)
  pkt_retrans: ["srt"],
  pkt_fec_extra: ["srt"],
  pkt_snd_loss: ["srt"],
  moqx_subscribe_success: ["moq"],
  moqx_subscribe_error: ["moq"],
  moqx_publish_namespace_success: ["moq"],
  moqx_publish_received: ["moq"],
  moqx_publish_done: ["moq"],

  // Media Health (container/timeline — not transport)
  ts_continuity_counter_errors: ["srt", "rtmp"],
  cmaf_seq_gap_count: ["moq"],
  cmaf_tfdt_gap_count: ["moq"],
  cmaf_tfdt_gap_ms: ["moq"],
  cmaf_tfdt_overlap_count: ["moq"],
  cmaf_parse_errors: ["moq"],
  cmaf_fragment_count: ["moq"],

  // Video quality
  vmaf_score: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  psnr_db: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  ssim: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],

  // Playback (normalized)
  playback_ttff_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_stall_count: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_bitrate_bps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_frames_rendered: ["moq", "srt", "hls"],
  playback_frames_dropped: ["moq", "srt", "hls"],
  playback_error_count: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_video_time_sec: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  e2e_latency_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
};

export function protocolLabel(protocol: ProtocolId): string {
  const value = (protocol || "").toLowerCase();
  if (!value) {
    return "unknown";
  }
  return value.toUpperCase();
}

export function metricSupportedForProtocol(metricKey: string, protocol: ProtocolId): boolean {
  const supported = METRIC_PROTOCOL_SUPPORT[metricKey];
  if (!supported) {
    return true;
  }
  return supported.includes((protocol || "").toLowerCase());
}

/** User-facing availability copy when a metric cannot be populated. */
export function metricUnavailableMessage(metricKey: string, protocol: ProtocolId): string {
  const proto = protocolLabel(protocol);
  const supported = METRIC_PROTOCOL_SUPPORT[metricKey];
  if (!supported || supported.length === 0) {
    return `Not available with protocol ${proto}`;
  }
  if (metricKey.startsWith("moqx_") || metricKey === "quic_rtt_ms") {
    return `Not available with protocol ${proto} (MoQ relay / QUIC only)`;
  }
  if (metricKey.startsWith("cmaf_")) {
    return `Not available with protocol ${proto} (MoQ CMAF Media Health)`;
  }
  if (metricKey === "ts_continuity_counter_errors") {
    return `Not available with protocol ${proto} (MPEG-TS / Zixi TR101 Media Health)`;
  }
  if (metricKey.startsWith("pkt_") || metricKey === "net_fec_pct") {
    return `Not available with protocol ${proto} (SRT/Zixi MPEG-TS path)`;
  }
  const others = supported.map((item) => protocolLabel(item)).join(", ");
  return `Not available with protocol ${proto} (supported: ${others})`;
}

/**
 * Estimated glass-to-glass latency for a realtime encode:
 * (wall clock since encode start) − (media time shown in the player).
 *
 * This includes intentional live buffers (e.g. HLS liveSyncDurationCount ≈ 2
 * segments). Do not subtract them — the metric is meant to reflect what the
 * viewer experiences, not theoretical transport-only delay.
 * Requires roughly NTP-aligned clocks on browser and publisher host.
 */
export function estimateE2eLatencyMs(
  encodeStartedAtEpoch: number | null | undefined,
  playbackVideoTimeSec: number,
): number | null {
  if (!encodeStartedAtEpoch || encodeStartedAtEpoch <= 0) {
    return null;
  }
  if (playbackVideoTimeSec <= 0) {
    return null;
  }
  const wallElapsedMs = Date.now() - encodeStartedAtEpoch * 1000;
  const mediaElapsedMs = playbackVideoTimeSec * 1000;
  const latency = wallElapsedMs - mediaElapsedMs;
  if (!Number.isFinite(latency) || latency < 0 || latency > 120_000) {
    return null;
  }
  return Math.round(latency);
}
