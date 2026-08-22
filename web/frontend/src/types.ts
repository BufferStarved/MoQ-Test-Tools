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
  cloud_provider?: string;
  cloud_region?: string;
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
  upload_latency_ms?: number | null;
  e2e_latency_ms?: number;
  // Latency decomposition (src/latency_budget.py ↔ latencyBudget.ts). The five
  // components sum to latency_accounted_ms; e2e minus that is the residual.
  latency_encode_ms?: number;
  latency_publish_ms?: number;
  latency_network_ms?: number;
  latency_packager_ms?: number;
  latency_player_buffer_ms?: number;
  latency_accounted_ms?: number;
  latency_residual_ms?: number;
  /** Components in excess of measured e2e — the signed other half. */
  latency_overcount_ms?: number;
  /** Comma-separated stage names with no instrument on this leg. */
  latency_unmeasured?: string;
  /** Which span e2e_latency_ms covers: capture_to_glass | ingest_to_glass. */
  latency_e2e_scope?: string;
  encode_frames_total?: number;
  encode_frames_dropped?: number;
  encode_frames_duped?: number;
  encode_frame_drop_pct?: number;
  playback_frame_drop_pct?: number;
  frame_delivery_pct?: number;
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
  cloud_provider?: string;
  cloud_region?: string;
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
  status: "pending" | "queued" | "running" | "completed" | "failed";
  protocol: string;
  endpoint_url: string;
  media_path: string;
  duration_sec: number;
  preset_id?: string;
  encode_ladder?: string | null;
  target_latency_ms?: number | null;
  publisher_host?: "cloud" | "local" | "browser" | string | null;
  moq_namespace?: string | null;
  zixi_stream_id?: string | null;
  /** Error-concealed derived stream for HLS playback, when Zixi concealment
   * is configured — falls back to zixi_stream_id otherwise. */
  zixi_playback_stream_id?: string | null;
  /** False for SRT until Zixi HLS serves a readable MPEG-TS segment. */
  preview_ready?: boolean;
  /** True while this cloud encode is blocked on MAX_CONCURRENT_CLOUD_ENCODES. */
  waiting_for_encode_slot?: boolean;
  /** Jobs already holding a slot or waiting in front of this one. */
  encode_queue_ahead?: number;
  encode_slot_limit?: number;
  created_at: string;
  started_at_epoch?: number | null;
  /** Wall-clock time of the first sample with real encode data (bitrate/fps
   * > 0). Prefer this over started_at_epoch for e2e latency: protocol setup
   * time before frames flow (endpoint probes, Zixi SRT ingest lock wait,
   * etc.) varies a lot by protocol and otherwise biases cross-protocol
   * latency comparisons toward whichever protocol takes longer to set up. */
  first_sample_at_epoch?: number | null;
  /** Wall epoch stamped right before the leg encoder spawned — media time m
   * was read at media_zero_epoch + m. Preferred glass-to-glass anchor. */
  media_zero_epoch?: number | null;
  /** LL-HLS only: encoder→packager transit (ms) measured server-side from the
   * first EXT-X-PROGRAM-DATE-TIME; added to PDT-based player latency. */
  packager_transit_ms?: number | null;
  /** Zixi Fast HLS: encode-media seconds at hls.js buffer time 0. */
  delivery_media_origin_sec?: number | null;
  csv_path?: string | null;
  summary_path?: string | null;
  error?: string | null;
  samples: UploadSample[];
  compute_vmaf_on_ingest?: boolean;
  compute_vmaf_encoder?: boolean;
  vmaf_status?: string | null;
  vmaf_score?: number | null;
  psnr_db?: number | null;
  ssim?: number | null;
  vmaf_error?: string | null;
  encoder_vmaf_status?: string | null;
  encoder_vmaf_score?: number | null;
  encoder_psnr_db?: number | null;
  encoder_ssim?: number | null;
  encoder_vmaf_error?: string | null;
  /** True after the operator hits Stop (or the job is cancelled). */
  cancelled?: boolean;
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

/**
 * Per-run summary values keyed by CSV column.
 *
 * Named and index-signed on purpose. The backend derives this bag from
 * whatever columns exist in `CSV_COLUMNS`, so a closed object type forces an
 * edit here for every new metric — and the common `result.averages ?? {}`
 * idiom widened to `Averages | {}`, which made *every* property read a type
 * error. The listed keys stay for autocomplete and documentation.
 *
 * Not all entries are means: cumulative counters are run totals from the final
 * sample (see `averages_note` in the summary JSON).
 */
export interface ResultAverages {
  [column: string]: number | undefined;
  cpu_percent?: number;
  memory_mb?: number;
  encoded_bitrate_kbps?: number;
  fps?: number;
  fps_stability?: number;
  speed?: number;
  encode_lag_ms?: number;
  upload_latency_ms?: number;
  // Latency decomposition (src/latency_budget.py).
  latency_encode_ms?: number;
  latency_publish_ms?: number;
  latency_network_ms?: number;
  latency_packager_ms?: number;
  latency_player_buffer_ms?: number;
  latency_accounted_ms?: number;
  latency_residual_ms?: number;
  latency_overcount_ms?: number;
  // Frame accounting.
  encode_frames_total?: number;
  encode_frames_dropped?: number;
  encode_frames_duped?: number;
  encode_frame_drop_pct?: number;
  playback_frame_drop_pct?: number;
  frame_delivery_pct?: number;
}

/**
 * The non-numeric entries in the same bag.
 *
 * Kept as an intersection rather than extra properties on `ResultAverages`
 * because that interface's index signature is `number | undefined`, and
 * widening it to include `string` would make every arithmetic read of an
 * average a type error. These are annotations, not measurements.
 *
 * Note the key is `latency_unmeasured_stages`, not the per-sample
 * `latency_unmeasured`: the run-level value only lists stages that had no
 * instrument on *every* sample, so it is a different (stricter) statement
 * than any single row's.
 */
export interface ResultAverageAnnotations {
  latency_unmeasured_stages?: string;
}

export interface ResultSummary {
  filename: string;
  samples: number;
  protocol?: string | null;
  endpoint?: string | null;
  averages?: ResultAverages &
    ResultAverageAnnotations & {
    transport_rtt_ms?: number;
    net_rtt_ms?: number;
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
    playback_fps?: number;
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
    /** Player that actually produced the playback columns (whep, ll-hls, moq…). */
    playback_engine?: string;
    /** Set when playback_engine is not the protocol's own delivery path. */
    playback_engine_caveat?: string;
  };
}
