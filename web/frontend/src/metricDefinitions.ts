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
      "Round-trip time for the active transport instrument: libsrt (SRT path) or Zixi REST API (receiver-side). Not populated for MoQ unless a compatible transport source is wired.",
  },
  transport_rtt_jitter_ms: {
    label: "Transport jitter",
    description:
      "Variation in transport RTT between samples. For SRT this is mean |ΔRTT| over consecutive libsrt readings; Zixi may supply receiver jitter when the API poller is enabled.",
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
    description: "Cumulative SRT retransmitted packets. Retransmits recover loss but add latency and bandwidth overhead.",
  },
  pkt_fec_extra: {
    label: "FEC recovery packets",
    description: "Extra forward-error-correction packets sent by SRT beyond the media payload (pktSndFilterExtra).",
  },
  ts_continuity_counter_errors: {
    label: "TS continuity counter errors",
    description:
      "MPEG-TS continuity-counter errors from Zixi TR101 analysis. Meaningful for TS-muxed SRT/RTMP only — not applicable to MoQ fMP4.",
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
    description: "Video Multimethod Assessment Fusion score computed post-ingest against the source media. Scores closer to 100 indicate higher perceived quality.",
  },
  psnr_db: {
    label: "PSNR",
    description:
      "Peak signal-to-noise ratio in decibels from libvmaf (feature=name=psnr). Populated when VMAF runs with PSNR/SSIM features enabled.",
  },
  ssim: {
    label: "SSIM",
    description:
      "Structural similarity index from libvmaf (feature=name=float_ssim). Populated when VMAF runs with PSNR/SSIM features enabled.",
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
      "CPU utilization on the managed ingest/relay host (Zixi VM for SRT, moqx relay for MoQ). 0% often means not collected rather than idle — check server_metrics_enabled in the summary.",
  },
  server_memory_percent: {
    label: "Server memory",
    description:
      "Memory utilization on the managed ingest/relay host. 0% often means not collected rather than idle.",
  },
  server_disk_percent: {
    label: "Server disk",
    description:
      "Disk utilization on the managed ingest/relay host. 0% often means not collected rather than idle.",
  },
  moqx_subscribe_success: {
    label: "Relay subscribe OK",
    description: "Cumulative moqx relay subscriptions accepted (Prometheus counter). Global since relay restart, not per-browser.",
  },
  moqx_subscribe_error: {
    label: "Relay subscribe errors",
    description: "Cumulative moqx relay subscription rejections (Prometheus counter).",
  },
  moqx_publish_namespace_success: {
    label: "Relay publish OK",
    description: "Cumulative successful namespace publish announcements accepted by the moqx relay.",
  },
  moqx_publish_received: {
    label: "Relay objects received",
    description: "Cumulative MoQT objects received by the moqx relay from publishers.",
  },
  moqx_publish_done: {
    label: "Relay publish sessions closed",
    description: "Cumulative publish sessions completed on the moqx relay since last restart.",
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
    label: "QUIC packets lost",
    description: "Cumulative recovery/packet_lost events in the publisher picoquic qlog trace.",
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
    description: "Milliseconds until the first rendered frame, from @playa/player stats.",
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
