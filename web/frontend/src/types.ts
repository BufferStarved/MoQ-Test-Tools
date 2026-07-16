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
  pkt_rcv_drop?: number;
  pkt_snd_drop?: number;
  pkt_snd_loss?: number;
  pkt_retrans?: number;
  pkt_fec_extra?: number;
  ts_continuity_counter_errors?: number;
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
  moq_namespace?: string | null;
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
  vmaf_error?: string | null;
  encoder_vmaf_status?: string;
  encoder_vmaf_score?: number | null;
  encoder_vmaf_error?: string | null;
}

export interface ResultFile {
  filename: string;
  path: string;
  modified_at: string;
  size_bytes: number;
  comparison_id?: string;
  stream_index?: number;
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
    transport_rtt_ms?: number;
    transport_rtt_jitter_ms?: number;
    pkt_rcv_drop?: number;
    pkt_snd_drop?: number;
    pkt_retrans?: number;
    pkt_fec_extra?: number;
    ts_continuity_counter_errors?: number;
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
    vmaf_computed_on?: string;
    vmaf_distorted_path?: string;
    vmaf_pending_on_ingest?: boolean;
    vmaf_note?: string;
  };
}
