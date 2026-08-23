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
      "Publisher-side metrics: bitrate, frame rate, send rate, client memory/jitter, encode lag, upload latency, speed/FPS stability, and encoder-side VMAF/PSNR/SSIM.",
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
  upload_latency_ms: ["srt", "rtmp", "webrtc", "moq"],

  // Latency decomposition. Every leg reports every component in the same
  // units. A stage with no instrument on a given path reports 0 *and names
  // itself in latency_unmeasured*, so its time lands in latency_residual_ms
  // without the 0 reading as "this stage was free".
  latency_encode_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  // No protocol measures steady-state publish transit yet; the column exists
  // so the stage is named rather than silently missing from the chain.
  latency_publish_ms: ["srt", "rtmp", "webrtc", "moq"],
  // MoQ is absent on purpose: no RTT source is wired for the openmoq
  // publisher (no qlog, relay admin TCP unreachable), so a MoQ network figure
  // would be invented.
  latency_network_ms: ["srt", "rtmp", "webrtc"],
  // Measured only where the packager stamps a wall clock we can difference
  // (MediaMTX LL-HLS PDT). Zixi HTTP-TS is a measured ~0 by construction;
  // Zixi Fast HLS carries no PDT, so it has no instrument at all.
  latency_packager_ms: ["srt", "rtmp", "hls", "dash"],
  latency_player_buffer_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  latency_accounted_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  latency_residual_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  latency_overcount_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  latency_unmeasured: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  latency_e2e_scope: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],

  // Frame accounting. Encoder counters come from ffmpeg -progress, so browser
  // publish paths (no ffmpeg) cannot fill them.
  encode_frames_total: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encode_frames_dropped: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encode_frames_duped: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encode_frame_drop_pct: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_frame_drop_pct: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  frame_delivery_pct: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  encoder_send_rate_mbps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],

  // Normalized transport
  net_rtt_ms: ["srt", "rtmp", "webrtc", "moq"],
  net_jitter_ms: ["srt", "rtmp", "webrtc", "moq"],
  net_send_mbps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  net_recv_mbps: ["srt", "rtmp", "webrtc", "moq"],
  net_loss_pct: ["srt", "rtmp", "webrtc", "moq"],
  net_retrans_pct: ["srt", "rtmp", "webrtc", "moq"],
  net_fec_pct: ["srt"],

  // Legacy aliases (same support as normalized)
  transport_rtt_ms: ["srt", "rtmp", "webrtc", "moq"],
  transport_rtt_jitter_ms: ["srt", "rtmp", "webrtc", "moq"],
  transport_recv_rate_mbps: ["srt", "rtmp", "webrtc", "moq"],
  quic_rtt_ms: ["moq"],
  quic_cwnd_bytes: ["moq"],
  quic_packets_lost: ["moq"],
  pkt_rcv_drop: ["srt"],
  pkt_snd_drop: ["srt"],

  // Server
  server_cpu_percent: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  server_memory_percent: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  server_disk_percent: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],

  // Edge transport recovery (Zixi/SRT + WebRTC/MoQ stand-ins)
  pkt_retrans: ["srt", "webrtc", "moq"],
  pkt_fec_extra: ["srt"],
  pkt_snd_loss: ["srt", "webrtc", "moq"],
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
  psnr_db_encoder: ["srt", "rtmp", "http", "hls", "dash", "moq"],
  ssim_encoder: ["srt", "rtmp", "http", "hls", "dash", "moq"],
  vmaf_score_ingest: ["srt", "rtmp", "http", "hls", "dash", "moq"],
  psnr_db_ingest: ["srt", "rtmp", "http", "hls", "dash", "moq"],
  ssim_ingest: ["srt", "rtmp", "http", "hls", "dash", "moq"],

  // Playback (normalized)
  playback_ttff_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_stall_count: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_buffer_sec: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  // MoQ only, and only the LOC canvas within it: every other engine has an
  // HTMLMediaElement whose buffered range is a forward-looking quantity, so
  // "behind live" has no meaning there and must not be charted as if it did.
  playback_behind_live_sec: ["moq"],
  playback_rebuffer_sec: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_bitrate_bps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_frames_rendered: ["moq", "srt", "hls", "webrtc", "rtmp", "dash"],
  playback_frames_dropped: ["moq", "srt", "hls", "webrtc", "rtmp", "dash"],
  playback_fps: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_error_count: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  playback_video_time_sec: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
  e2e_latency_ms: ["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"],
};

/**
 * Playback engines that measure a protocol's own delivery path. Anything else
 * means the player consumed a remux, so the playback columns describe the
 * remux rather than the protocol named in the `protocol` column.
 */
const NATIVE_PLAYBACK_ENGINES: Record<string, string[]> = {
  webrtc: ["whep"],
  moq: ["moq"],
  srt: ["mpegts", "hls", "ll-hls", "dash"],
  rtmp: ["mpegts", "hls", "ll-hls", "dash"],
  hls: ["hls", "ll-hls", "mpegts"],
  dash: ["dash"],
  http: ["mpegts", "hls", "ll-hls", "dash"],
};

/**
 * Warn when playback metrics do not describe the published protocol.
 *
 * Job c49d2ef4 (2026-08-22) motivates this: tagged `protocol=webrtc`, but the
 * tile played the LL-HLS remux of the WHIP ingest, so its TTFF, stalls,
 * rebuffer and glass delay were HLS numbers being ranked against other legs as
 * if they were WebRTC. Mirror of playback_metrics.playback_engine_caveat.
 */
export function playbackEngineCaveat(
  protocol: string | null | undefined,
  playbackEngine: string | null | undefined,
): string {
  const proto = (protocol || "").trim().toLowerCase();
  const engine = (playbackEngine || "").trim().toLowerCase();
  if (!proto || !engine) {
    return "";
  }
  const native = NATIVE_PLAYBACK_ENGINES[proto];
  if (!native || native.includes(engine)) {
    return "";
  }
  const upper = proto.toUpperCase();
  return (
    `Playback metrics were measured with the '${engine}' player, which is not ` +
    `${upper}'s own delivery path. TTFF, stalls, rebuffer and glass delay describe ` +
    `that remux, not ${upper} — do not compare them directly against legs played ` +
    "on their native path."
  );
}

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

/** Parse ffmpeg out_time ("HH:MM:SS.micro") to seconds; 0 when unparseable. */
export function parseOutTimeSec(outTime?: string | null): number {
  const value = (outTime ?? "").trim();
  if (!value || value === "N/A") {
    return 0;
  }
  const parts = value.split(":");
  if (parts.length !== 3) {
    return 0;
  }
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }
  return Math.max(0, hours * 3600 + minutes * 60 + seconds);
}

/**
 * Wall-clock epoch (seconds) when the encoder's media clock (`out_time`)
 * started advancing — the correct anchor for wall−playhead latency.
 *
 * Neither job epoch is right on its own: `started_at_epoch` is job-thread
 * creation and includes the full protocol setup + webcam-broker warmup (~6s),
 * and `first_sample_at_epoch` fires on the first sample with bitrate/fps > 0,
 * which can still precede the first encoded frame. Instead, at the first
 * sample whose out_time is positive, (sample wall time − out_time) is the
 * instant media time began — out_time advances at realtime for a live encode.
 * Sample wall times are reconstructed from first_sample_at_epoch plus the
 * elapsed_sec delta. Returns null (callers must treat latency as unknown)
 * rather than ever falling back to started_at_epoch.
 */
export function deriveEncodeAnchorEpoch(
  job:
    | { media_zero_epoch?: number | null; first_sample_at_epoch?: number | null }
    | null
    | undefined,
  samples:
    | Array<{
        elapsed_sec: number;
        out_time?: string;
        encoded_bitrate_kbps?: number;
        fps?: number;
      }>
    | null
    | undefined,
): number | null {
  // Preferred: the server stamps media_zero_epoch immediately before the leg
  // encoder spawns — media time m is read at media_zero_epoch + m. The
  // out_time-based derivation below is a fallback for old payloads: out_time
  // is the MUX clock, which lags the read clock by the encoder pipeline delay
  // (x264 lookahead + mux buffering, ~2s measured 2026-08-09), so it
  // understates latency by that amount on every leg.
  const mediaZero = job?.media_zero_epoch;
  if (mediaZero && mediaZero > 0) {
    return mediaZero;
  }
  const firstSampleEpoch = job?.first_sample_at_epoch;
  if (!firstSampleEpoch || firstSampleEpoch <= 0 || !samples || samples.length === 0) {
    return null;
  }
  // The sample that set first_sample_at_epoch: first with real encode data.
  const firstLive = samples.find(
    (sample) => (sample.encoded_bitrate_kbps ?? 0) > 0 || (sample.fps ?? 0) > 0,
  );
  if (!firstLive) {
    return null;
  }
  const firstOut = samples.find((sample) => parseOutTimeSec(sample.out_time) > 0);
  if (!firstOut) {
    // Browser publishers have no ffmpeg out_time. First live sample minus
    // its elapsed_sec is when the in-tab encoder started.
    return firstSampleEpoch - firstLive.elapsed_sec;
  }
  const wallOfFirstOut = firstSampleEpoch + (firstOut.elapsed_sec - firstLive.elapsed_sec);
  return wallOfFirstOut - parseOutTimeSec(firstOut.out_time);
}

// The per-protocol e2e latency estimators that used to live here
// (estimateE2eLatencyMs, estimateMoqE2eLatencyMs) are gone: every player now
// stamps the SAME capture-anchored, clock-skew-corrected formula into its
// snapshot — (server-clock now − encode anchor) − encoder-timeline playhead
// + bridge lag — inside its captureAnchoredE2eMs(). See clockSkew.ts and the
// join-offset plumbing in vendor/moq-playa for the pieces that made a single
// formula possible across HTTP-TS, LL-HLS, and MoQ MSE timelines.

/** Shown on the encode bitrate chart when a WHIP/WebRTC publish has no bitrate. */
export const WHIP_ENCODE_BITRATE_NOTE =
  "ffmpeg's WHIP muxer does not report encode bitrate (progress bitrate=N/A). This chart uses MediaMTX ingest receive rate when available; otherwise the WHIP series stays at 0.";

export function webrtcEncodeBitrateUnreported(
  protocol: string | undefined,
  samples?: Array<{ encoded_bitrate_kbps?: number; fps?: number }> | null,
  averages?: { encoded_bitrate_kbps?: number; fps?: number } | null,
): boolean {
  if ((protocol || "").toLowerCase() !== "webrtc") {
    return false;
  }
  const list = samples ?? [];
  if (list.length > 0) {
    const ran = list.some((sample) => (sample.fps ?? 0) > 0 || (sample.encoded_bitrate_kbps ?? 0) > 0);
    if (!ran) {
      return false;
    }
    return list.every((sample) => (sample.encoded_bitrate_kbps ?? 0) <= 0);
  }
  return (averages?.fps ?? 0) > 0 && (averages?.encoded_bitrate_kbps ?? 0) <= 0;
}
