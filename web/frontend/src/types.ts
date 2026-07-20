import type { PlaybackMode } from "./playbackTypes";

export interface Protocol {
  id: string;
  label: string;
  syntax: string;
}

export interface Preset {
  id: string;
  name: string;
  protocol: string;
  url?: string;
  notes: string;
  env_vars: string[];
  requires_env: boolean;
  supports_vmaf?: boolean;
  ingest_provider?: string;
  web_available?: boolean;
}

export interface UploadSample {
  elapsed_sec: number;
  encoded_bitrate_kbps: number;
  fps: number;
  fps_stability: number;
  speed: number;
  out_time: string;
  cpu_percent: number;
  memory_mb: number;
  progress: string;
  transport_rtt_ms?: number;
  transport_rtt_jitter_ms?: number;
  net_rtt_ms?: number;
  net_jitter_ms?: number;
  net_send_mbps?: number;
  net_recv_mbps?: number;
  net_loss_pct?: number;
  net_retrans_pct?: number;
  encode_lag_ms?: number;
  e2e_latency_ms?: number;
  playback_error_count?: number;
  pkt_rcv_drop?: number;
  pkt_snd_drop?: number;
  pkt_snd_loss?: number;
  pkt_retrans?: number;
  pkt_fec_extra?: number;
  ts_continuity_counter_errors?: number;
  cmaf_fragment_count?: number;
  cmaf_seq_gap_count?: number;
  cmaf_tfdt_gap_count?: number;
  cmaf_tfdt_gap_ms?: number;
  cmaf_tfdt_overlap_count?: number;
  cmaf_parse_errors?: number;
  vmaf_score?: number | null;
  psnr_db?: number | null;
  ssim?: number | null;
  encoder_send_rate_mbps?: number;
  transport_recv_rate_mbps?: number;
  client_memory_percent?: number;
  client_disk_percent?: number;
  server_cpu_percent?: number;
  server_memory_percent?: number;
  server_disk_percent?: number;
  moqx_subscribe_success?: number;
  moqx_subscribe_error?: number;
  moqx_publish_namespace_success?: number;
  moqx_publish_received?: number;
  moqx_publish_done?: number;
  quic_rtt_ms?: number;
  quic_cwnd_bytes?: number;
  quic_packets_lost?: number;
  playback_stats_events?: number;
  playback_stall_count?: number;
  playback_frames_rendered?: number;
  playback_frames_dropped?: number;
  playback_bitrate_bps?: number;
  playback_ttff_ms?: number;
  playback_hls_errors?: number;
  playback_hls_fatal_errors?: number;
  playback_hls_buffer_stalls?: number;
  playback_hls_frag_loads?: number;
  playback_video_time_sec?: number;
  playback_buffer_sec?: number;
  playback_rebuffer_sec?: number;
}

export interface EndpointConfig {
  id: string;
  protocol: string;
  ingestEndpointId: string;
  endpointUrl: string;
  vmafAvailable: boolean;
  serverMetricsAvailable: boolean;
  playbackMode?: PlaybackMode;
  playbackDvr?: boolean;
  whepPlaybackUrl?: string;
  moqRelayUrl?: string;
  moqFingerprintUrl?: string;
  moqNamespace?: string;
}

export interface UploadJob {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  protocol: string;
  endpoint_url: string;
  media_path: string;
  duration_sec: number;
  preset_id?: string;
  encode_ladder?: string | null;
  target_latency_ms?: number | null;
  publisher_host?: "cloud" | "local" | string | null;
  moq_namespace?: string | null;
  zixi_stream_id?: string | null;
  /** Error-concealed derived stream for HLS playback, when Zixi concealment
   * is configured — falls back to zixi_stream_id otherwise. */
  zixi_playback_stream_id?: string | null;
  /** False for SRT until Zixi HLS serves a readable MPEG-TS segment. */
  preview_ready?: boolean;
  created_at: string;
  started_at_epoch?: number | null;
  csv_path?: string | null;
  summary_path?: string | null;
  error?: string | null;
  samples: UploadSample[];
  compute_vmaf_on_ingest?: boolean;
  compute_vmaf_encoder?: boolean;
  vmaf_status?: string;
  vmaf_score?: number | null;
  psnr_db?: number | null;
  ssim?: number | null;
  vmaf_error?: string | null;
  encoder_vmaf_status?: string;
  encoder_vmaf_score?: number | null;
  encoder_psnr_db?: number | null;
  encoder_ssim?: number | null;
  encoder_vmaf_error?: string | null;
}

export interface ResultFile {
  filename: string;
  path: string;
  modified_at: string;
  size_bytes: number;
  comparison_id?: string;
  stream_index?: number;
  protocol?: string;
  stream_label?: string;
}

export interface QualityLeg {
  status: string;
  computed_on: string;
  vmaf_score?: number;
  psnr_db?: number;
  ssim?: number;
  distorted_path?: string;
  error?: string;
}

export interface ResultSummary {
  filename: string;
  samples: number;
  protocol: string;
  endpoint: string;
  averages: {
    cpu_percent: number;
    memory_mb: number;
    encoded_bitrate_kbps: number;
    fps: number;
    fps_stability?: number;
    speed: number;
    encode_lag_ms?: number;
    transport_rtt_ms?: number;
    transport_rtt_jitter_ms?: number;
    pkt_rcv_drop?: number;
    pkt_snd_drop?: number;
    pkt_retrans?: number;
    pkt_fec_extra?: number;
    ts_continuity_counter_errors?: number;
    cmaf_fragment_count?: number;
    cmaf_seq_gap_count?: number;
    cmaf_tfdt_gap_count?: number;
    cmaf_tfdt_gap_ms?: number;
    cmaf_tfdt_overlap_count?: number;
    cmaf_parse_errors?: number;
    vmaf_score?: number;
    psnr_db?: number;
    ssim?: number;
    encoder_send_rate_mbps?: number;
    transport_recv_rate_mbps?: number;
    client_memory_percent?: number;
    client_disk_percent?: number;
    server_cpu_percent?: number;
    server_memory_percent?: number;
    server_disk_percent?: number;
    moqx_subscribe_success?: number;
    moqx_subscribe_error?: number;
    moqx_publish_namespace_success?: number;
    moqx_publish_received?: number;
    moqx_publish_done?: number;
    quic_rtt_ms?: number;
    quic_cwnd_bytes?: number;
    quic_packets_lost?: number;
    playback_stats_events?: number;
    playback_stall_count?: number;
    playback_frames_rendered?: number;
    playback_frames_dropped?: number;
    playback_bitrate_bps?: number;
    playback_ttff_ms?: number;
    playback_hls_errors?: number;
    playback_hls_fatal_errors?: number;
    playback_hls_buffer_stalls?: number;
    playback_hls_frag_loads?: number;
    playback_video_time_sec?: number;
    playback_buffer_sec?: number;
    playback_rebuffer_sec?: number;
    e2e_latency_ms?: number;
    e2e_latency_max_ms?: number;
    playback_error_count?: number;
  };
  throughput?: {
    total_bytes_sent?: number;
    total_bytes_received?: number;
    peak_bandwidth_sent_mbps?: number;
    peak_bandwidth_received_mbps?: number;
  };
  rows: Record<string, string>[];
  quality?: {
    encoder?: QualityLeg;
    ingest?: QualityLeg;
  };
  summary_extra?: {
    comparison_id?: string;
    stream_index?: number;
    stream_label?: string;
    encode_ladder?: string | null;
    encode_ladder_label?: string | null;
    height?: number | null;
    bitrate_kbps?: number | null;
    maxrate_kbps?: number | null;
    minrate_kbps?: number | null;
    target_latency_ms?: number | null;
    gop_frames?: number | null;
    srt_latency_us?: number | null;
    hls_segment_sec?: number | null;
    hls_live_sync_duration_sec?: number | null;
    hls_live_sync_count?: number | null;
    moq_target_latency_ms?: number | null;
    vmaf_computed_on?: string;
    vmaf_distorted_path?: string;
    vmaf_pending_on_ingest?: boolean;
    vmaf_note?: string;
  };
}
