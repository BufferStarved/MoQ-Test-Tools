export interface MetricDefinition {
  label: string;
  description: string;
}

export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  protocol: {
    label: "Protocol",
    description: "The publish protocol used for this stream (SRT, RTMP, MoQ, HLS, DASH, or WebRTC).",
  },
  samples: {
    label: "Samples",
    description: "Number of telemetry samples collected during the run, typically one per second of the live stream.",
  },
  encoded_bitrate_kbps: {
    label: "Encoded bitrate",
    description:
      "ffmpeg's reported encoder output bitrate for the source track. Measures encode load before the network path — not delivered network throughput.",
  },
  fps: {
    label: "Frame rate",
    description: "Frames per second observed in the ffmpeg output while the stream was being published.",
  },
  fps_stability: {
    label: "Frame rate stability",
    description: "Coefficient of variation of frame rate over the run. Lower values mean a steadier, less jittery encode.",
  },
  speed: {
    label: "Speed",
    description: "ffmpeg processing speed relative to real time. 1.0x means encoding and publishing keep pace with the live stream duration.",
  },
  transport_rtt_ms: {
    label: "Transport RTT",
    description:
      "Legacy alias for net_rtt_ms. Round-trip time from libsrt (SRT) or Zixi REST API (receiver-side).",
  },
  transport_rtt_jitter_ms: {
    label: "Transport jitter",
    description:
      "Legacy alias for net_jitter_ms. Variation in transport RTT between samples.",
  },
  net_rtt_ms: {
    label: "Network RTT",
    description:
      "Normalized round-trip time (ms). SRT → libsrt/Zixi RTT; RTMP → Zixi receiver RTT when available, otherwise TCP connect probe to the RTMP host:port; MoQ → picoquic qlog smoothed RTT when available, otherwise TCP path probe to the relay admin port (same host as WebTransport).",
  },
  net_jitter_ms: {
    label: "Network jitter",
    description:
      "Normalized RTT jitter (ms) from successive RTT samples. SRT → libsrt; RTMP/MoQ → path-probe or Zixi RTT variance (same estimator).",
  },
  net_send_mbps: {
    label: "Network send rate",
    description: "Normalized outbound rate in Mbps (transport send when available, else encoded bitrate).",
  },
  net_recv_mbps: {
    label: "Network receive rate",
    description: "Normalized inbound rate in Mbps when the transport exposes it (SRT).",
  },
  net_loss_pct: {
    label: "Network loss %",
    description:
      "Best-effort packet loss percentage. SRT → libsrt/Zixi; MoQ → moqx_quicPacketLoss_total job-window rate.",
  },
  net_retrans_pct: {
    label: "Retransmit %",
    description:
      "Merged, cross-protocol retransmit percentage — SRT's ARQ retransmit rate and MoQ's moqx_quicPacketRetransmissions_total job-window rate reported on one normalized series so the Ingest tab needs only a single retransmit chart.",
  },
  encode_lag_ms: {
    label: "Encode lag",
    description:
      "Wall-clock time minus ffmpeg media out_time while publishing. Large values mean the encoder is falling behind realtime.",
  },
  e2e_latency_ms: {
    label: "E2E latency (estimated)",
    description:
      "Estimated glass-to-glass latency, capture-anchored per player. Zixi HTTP-TS / Fast HLS: wall clock since encode start − media playhead (+ webcam bridge lag). MediaMTX LL-HLS: hls.js PDT latency + encode lag + bridge. MoQ: CaptureTimestamp when present, else wall − MoQ media timeline (+ bridge). Distinct from TTFF.",
  },
  playback_error_count: {
    label: "Player errors",
    description: "Normalized browser player error count (HLS fatal+nonfatal today; MoQ when wired).",
  },
  pkt_rcv_drop: {
    label: "Receive packet drops",
    description:
      "Cumulative receive-side packet drops (libsrt pktRcvDrop). On a sender-only SRT connection this is often 0 — check Zixi receiver stats for ingest-side drops.",
  },
  pkt_snd_drop: {
    label: "Send packet drops",
    description: "Cumulative send-side packet drops from the publisher (libsrt pktSndDrop).",
  },
  pkt_snd_loss: {
    label: "Send packet loss",
    description: "Cumulative sender packet loss reported by libsrt (pktSndLoss).",
  },
  pkt_retrans: {
    label: "Retransmits",
    description:
      "Cumulative SRT retransmitted packets. Retransmits recover loss but add latency and bandwidth overhead. Superseded on the Ingest tab by the merged, cross-protocol net_retrans_pct series.",
  },
  pkt_fec_extra: {
    label: "FEC recovery packets",
    description: "Extra forward-error-correction packets sent by SRT beyond the media payload (pktSndFilterExtra).",
  },
  ts_continuity_counter_errors: {
    label: "TS continuity errors",
    description:
      "Media Health (MPEG-TS): continuity-counter errors from Zixi TR 101 290 analysis. Not a transport metric. MoQ uses CMAF sequence/decode-time gaps instead.",
  },
  cmaf_seq_gap_count: {
    label: "CMAF sequence gaps",
    description:
      "Media Health (MoQ/CMAF): count of mfhd.sequence_number discontinuities (not +1). Analogue of TS continuity errors for fragmented MP4.",
  },
  cmaf_tfdt_gap_count: {
    label: "CMAF decode-time gaps",
    description:
      "Media Health (MoQ/CMAF): count of tfdt baseMediaDecodeTime jumps larger than the prior fragment duration (+ slack).",
  },
  cmaf_tfdt_gap_ms: {
    label: "CMAF decode-time gap",
    description: "Media Health (MoQ/CMAF): total decode-time discontinuity duration in milliseconds.",
  },
  cmaf_tfdt_overlap_count: {
    label: "CMAF timeline overlaps",
    description: "Media Health (MoQ/CMAF): fragments whose decode time rewinds relative to the prior fragment end.",
  },
  cmaf_parse_errors: {
    label: "CMAF parse errors",
    description: "Media Health (MoQ/CMAF): unparseable or malformed moof/mdat structures in the recording.",
  },
  cmaf_fragment_count: {
    label: "CMAF fragments",
    description: "Number of moof fragments observed in the MoQ fMP4 capture used for Media Health analysis.",
  },
  encoder_send_rate_mbps: {
    label: "Encoder send rate",
    description:
      "Outbound rate in Mbps. Defaults to encoded_bitrate_kbps / 1000 when no transport-level send measurement exists; srt-live-transmit supplies a measured value when enabled.",
  },
  transport_recv_rate_mbps: {
    label: "Transport receive rate",
    description: "Measured receive bandwidth from libsrt when srt-live-transmit stats are enabled.",
  },
  vmaf_score: {
    label: "VMAF",
    description:
      "Video Multimethod Assessment Fusion score against the source media, picking whichever stage (encoder capture or post-ingest recording) is available. Scores closer to 100 indicate higher perceived quality. The Encode/Publish and Ingest tabs chart the encoder- and ingest-side scores separately — see vmaf_score_encoder / vmaf_score_ingest.",
  },
  psnr_db: {
    label: "PSNR",
    description:
      "Peak signal-to-noise ratio in decibels from libvmaf (feature=name=psnr), picking whichever stage is available. Populated when VMAF runs with PSNR/SSIM features enabled.",
  },
  ssim: {
    label: "SSIM",
    description:
      "Structural similarity index from libvmaf (feature=name=float_ssim), picking whichever stage is available. Populated when VMAF runs with PSNR/SSIM features enabled.",
  },
  vmaf_score_encoder: {
    label: "VMAF",
    description:
      "VMAF computed against the encoder's own output (pre-network capture). Isolates encode-time quality loss from anything the network/ingest path adds. Shown on the Encode/Publish tab.",
  },
  psnr_db_encoder: {
    label: "PSNR",
    description: "PSNR (dB) against the encoder's own output, from libvmaf. Shown on the Encode/Publish tab.",
  },
  ssim_encoder: {
    label: "SSIM",
    description: "SSIM against the encoder's own output, from libvmaf. Shown on the Encode/Publish tab.",
  },
  vmaf_score_ingest: {
    label: "VMAF (ingest)",
    description:
      "VMAF computed against the recording captured at the ingest/relay side, after the network path. Differences from the encoder-side score point at network/transport quality loss. Shown on the Ingest tab.",
  },
  psnr_db_ingest: {
    label: "PSNR (ingest)",
    description: "PSNR (dB) against the post-ingest recording, from libvmaf. Shown on the Ingest tab.",
  },
  ssim_ingest: {
    label: "SSIM (ingest)",
    description: "SSIM against the post-ingest recording, from libvmaf. Shown on the Ingest tab.",
  },
  total_bytes_sent: {
    label: "Total bytes sent",
    description: "Estimated total payload bytes sent by the publisher during the benchmark window.",
  },
  total_bytes_received: {
    label: "Total bytes received",
    description: "Estimated total bytes received by the transport or ingest path during the benchmark window.",
  },
  peak_bandwidth_sent_mbps: {
    label: "Peak send bandwidth",
    description: "Highest observed outbound bandwidth during the run, in megabits per second.",
  },
  peak_bandwidth_received_mbps: {
    label: "Peak receive bandwidth",
    description: "Highest observed inbound bandwidth during the run, in megabits per second.",
  },
  cpu_percent: {
    label: "Process CPU",
    description: "CPU usage of the ffmpeg (and publisher/SRT bridge) processes on the client host.",
  },
  memory_mb: {
    label: "Process memory",
    description: "Resident memory used by ffmpeg and related publish processes on the client host.",
  },
  client_memory_percent: {
    label: "Client host memory",
    description: "Overall memory utilization on the machine running ffmpeg, not just the encoder process.",
  },
  client_disk_percent: {
    label: "Client host disk",
    description: "Disk utilization on the client host where ffmpeg is running.",
  },
  server_cpu_percent: {
    label: "Server CPU",
    description:
      "CPU on the destination edge VM. Zixi: ingest-agent psutil (GCP Monitoring fallback). MoQ: GCP Monitoring on the relay instance. 0% often means not collected.",
  },
  server_memory_percent: {
    label: "Server memory",
    description:
      "Memory on the destination edge VM (ingest agent and/or GCP Monitoring). 0% often means not collected.",
  },
  server_disk_percent: {
    label: "Server disk",
    description:
      "Disk on the destination edge VM (ingest agent and/or GCP Monitoring). 0% often means not collected.",
  },
  moqx_subscribe_error: {
    label: "Relay subscribe errors (Δ)",
    description: "MoQ relay subscription rejections as a job-window delta.",
  },
  moqx_publish_namespace_success: {
    label: "Relay publish OK (Δ)",
    description: "Successful namespace publish announcements as a job-window delta.",
  },
  moqx_publish_done: {
    label: "Relay publish sessions closed",
    description: "Publish sessions completed on the moqx relay (Prometheus counter).",
  },
  quic_rtt_ms: {
    label: "QUIC RTT",
    description: "Smoothed round-trip time from the moq5 publisher picoquic qlog (recovery/metrics_updated), in milliseconds.",
  },
  quic_cwnd_bytes: {
    label: "QUIC congestion window",
    description: "Congestion window size in bytes from the moq5 publisher picoquic qlog.",
  },
  quic_packets_lost: {
    label: "Receive loss",
    description:
      "MoQ-only, ingest-side. Cumulative QUIC packets the moqx relay logged as lost while receiving from the publisher (moqx quicPacketLoss_total job-window delta), or the publisher's own picoquic packet_lost count on the moq5 backend. This is MoQ's receive-side counterpart to SRT's Send loss (pkt_snd_loss) — same transport-loss concept, observed from the relay/receiver rather than the sender, since the default openmoq-publisher exposes no sender-side loss telemetry.",
  },
  playback_stats_events: {
    label: "Playa stats events",
    description: "Count of @playa/player stats events emitted during MoQ browser playback (~1 Hz once frames render).",
  },
  playback_stall_count: {
    label: "Playback stalls",
    description: "Cumulative stall count from @playa/player (MoQ) or hls.js BUFFER_STALLED_ERROR events (HLS).",
  },
  playback_frames_rendered: {
    label: "Frames rendered",
    description: "Cumulative frames rendered reported by @playa/player stats during MoQ playback.",
  },
  playback_frames_dropped: {
    label: "Frames dropped",
    description: "Cumulative frames dropped reported by @playa/player stats during MoQ playback.",
  },
  playback_bitrate_bps: {
    label: "Playback bitrate",
    description: "Receive bitrate in bits per second from @playa/player stats during MoQ playback.",
  },
  playback_ttff_ms: {
    label: "Time to first frame",
    description:
      "Milliseconds until the first rendered frame after the player goes live (MoQ: @playa/player; HLS: wall clock to video.currentTime > 0.25s).",
  },
  playback_buffer_sec: {
    label: "Buffer size",
    description:
      "Seconds of media buffered ahead of the playhead (HTMLMediaElement.buffered end − currentTime). Higher values mean more resilience to jitter; lower values track the live edge more tightly.",
  },
  playback_rebuffer_sec: {
    label: "Rebuffer time",
    description:
      "Cumulative seconds the player spent rebuffering after playback started — measured from each HTMLMediaElement 'waiting' event to the following 'playing' event. A rising line means the viewer is seeing stalls/spinners; flat means smooth playback.",
  },
  playback_hls_errors: {
    label: "HLS errors",
    description: "Total hls.js ERROR events observed in the browser player during the encode.",
  },
  playback_hls_fatal_errors: {
    label: "HLS fatal errors",
    description: "hls.js ERROR events marked fatal during browser playback.",
  },
  playback_hls_buffer_stalls: {
    label: "HLS buffer stalls",
    description: "Count of hls.js BUFFER_STALLED_ERROR media errors during browser playback.",
  },
  playback_hls_frag_loads: {
    label: "HLS fragments loaded",
    description: "Count of hls.js FRAG_LOADED events during browser playback.",
  },
  playback_video_time_sec: {
    label: "Video playback time",
    description: "Maximum <video> currentTime reached in the browser player during the encode.",
  },
};

export function metricDefinition(key: string): MetricDefinition | undefined {
  return METRIC_DEFINITIONS[key];
}
