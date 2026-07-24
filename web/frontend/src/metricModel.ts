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
  | "ingest"
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
    title: "Encode/Publish",
    description:
      "Publisher-side metrics: bitrate, frame rate, send rate, client memory/jitter, encode lag/speed/FPS stability, and encoder-side VMAF/PSNR/SSIM.",
  },
  {
    id: "ingest",
    title: "Ingest",
    description:
      "Normalized path health (RTT, jitter, loss%, retrans%) + ingest host health (CPU/mem/disk), protocol detail (MoQ relay counters, SRT/Zixi recovery), and post-ingest-recording VMAF/PSNR/SSIM.",
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
  net_rtt_ms: ["srt", "rtmp", "moq"],
  net_jitter_ms: ["srt", "rtmp", "moq"],
  net_send_mbps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  net_recv_mbps: ["srt"],
  net_loss_pct: ["srt", "moq"],
  net_retrans_pct: ["srt", "moq"],
  net_fec_pct: ["srt"],

  // Legacy aliases (same support as normalized)
  transport_rtt_ms: ["srt", "rtmp", "moq"],
  transport_rtt_jitter_ms: ["srt", "rtmp", "moq"],
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
  moqx_subscribe_error: ["moq"],
  moqx_publish_namespace_success: ["moq"],
  moqx_publish_done: ["moq"],

  // Media Health (container/timeline — not transport)
  ts_continuity_counter_errors: ["srt", "rtmp"],
  cmaf_seq_gap_count: ["moq"],
  cmaf_tfdt_gap_count: ["moq"],
  cmaf_tfdt_gap_ms: ["moq"],
  cmaf_tfdt_overlap_count: ["moq"],
  cmaf_parse_errors: ["moq"],
  cmaf_fragment_count: ["moq"],

  // Video quality (combined + staged encoder/ingest variants)
  vmaf_score: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  psnr_db: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  ssim: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  vmaf_score_encoder: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  psnr_db_encoder: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  ssim_encoder: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  vmaf_score_ingest: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  psnr_db_ingest: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  ssim_ingest: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],

  // Playback (normalized)
  playback_ttff_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_stall_count: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_buffer_sec: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_rebuffer_sec: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
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
  if (metricKey.startsWith("moqx_") || metricKey.startsWith("quic_")) {
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
 * `playbackVideoTimeSec` must be *session-relative* (seconds of media played
 * back in this run), not an absolute/container timestamp — callers rebase
 * raw `video.currentTime` before calling this (see HlsPlayer's
 * `sessionRelativeVideoTime` and MoqPlayer's join-relative MSE timeline).
 * Managed Zixi SRT applies a monotonic `-output_ts_offset` to
 * `video.currentTime` directly (see src/zixi_ts_offset.py); an un-rebased
 * absolute value there would corrupt this formula.
 *
 * This includes intentional live buffers (e.g. HLS liveSyncDurationCount ≈ 2
 * segments). Do not subtract them — the metric is meant to reflect what the
 * viewer experiences, not theoretical transport-only delay.
 * Requires roughly NTP-aligned clocks on browser and publisher host.
 *
 * Only valid when `playbackVideoTimeSec` is encode-anchored (Zixi HTTP-TS /
 * Fast HLS after optional ts_offset rebase). Do **not** use for MoQ MSE
 * timelines that re-zero at join — that freezes at join delay, not
 * glass-to-glass (see {@link estimateMoqE2eLatencyMs}).
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

/**
 * MoQ glass-to-glass estimate.
 *
 * Prefer player-reported CaptureTimestamp latency when present (playa still
 * hardcodes `latencyMs: 0` today — MoqPlayer therefore stamps a buffer-based
 * `e2e_latency_ms` into the snapshot). Otherwise estimate from the live
 * buffer lead (+ a small decode/render pad).
 *
 * Do **not** use wall−vt on the MSE `<video>` clock. Playa's `timeupdate` with
 * an active video sink is `video.currentTime * 1000`, which re-zeros at join —
 * so wall−vt freezes at (join wall − encode start). That is join delay / a
 * TTFF cousin, not glass-to-glass, and disagreed with the burnt-in ENC clock.
 */
export function estimateMoqE2eLatencyMs(options: {
  encodeStartedAtEpoch?: number | null;
  videoTimeSec: number;
  bufferSec: number;
  playerLatencyMs?: number;
  targetLatencyMs?: number;
}): number | null {
  const playerLatency = options.playerLatencyMs ?? 0;
  if (Number.isFinite(playerLatency) && playerLatency > 0 && playerLatency <= 120_000) {
    return Math.round(playerLatency);
  }

  // CaptureTimestamp / player stamp unavailable — buffer lead is the best
  // viewer-facing proxy once media is flowing. Options kept for call-site
  // compatibility / future SEI.
  void options.encodeStartedAtEpoch;
  void options.videoTimeSec;
  void options.targetLatencyMs;

  const bufferMs = Math.max(0, options.bufferSec) * 1000;
  if (bufferMs <= 0) {
    return null;
  }
  return Math.round(bufferMs + 250);
}
