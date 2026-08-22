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
      "ffmpeg's reported encoder output bitrate for the source track. Measures encode load before the network path — not delivered network throughput. ffmpeg's WHIP muxer does not emit bitrate in -progress; those jobs use MediaMTX ingest receive rate as a stand-in when available.",
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
    label: "Encode speed",
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
      "Normalized round-trip time (ms). SRT → libsrt/Zixi RTT; RTMP → Zixi receiver RTT when available, otherwise TCP connect probe to the RTMP host:port; WebRTC → ICE candidate-pair currentRoundTripTime; MoQ → picoquic qlog smoothed RTT when available, otherwise TCP path probe to the relay admin port (same host as WebTransport).",
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
      "How far the encoder is behind realtime (ms). ffmpeg: wall-clock minus media out_time after subtracting startup. Browser WebCodecs: wall since encode start minus the frame’s media timestamp. WebRTC WHIP: per-frame encode time from getStats, plus any capture-vs-encoded frame backlog.",
  },
  upload_latency_ms: {
    label: "Upload latency",
    description:
      "Publisher→ingest only: milliseconds from encoded bits ready to publish (ffmpeg -progress out_time / first muxed packet) to the first confirmed write at the ingest server. SRT: connected + first bytes acked (libsrt send rate or MediaMTX receive). RTMP: first ingest receive (MediaMTX/Zixi). MoQ: first object on the wire (live: sent track) or first relay namespace/group. WebRTC/OBS monitor: — until a publish-success signal exists. Not RTT, not glass-to-glass, not player TTFF.",
  },
  latency_encode_ms: {
    label: "Latency · encode",
    description:
      "Component 1 of the latency budget: capture → muxed output. The constant encoder pipeline offset (x264 lookahead, mux buffering, device/broker warmup — 1.2–2.4s typical) plus any sustained encode lag on top. encode_lag_ms deliberately charts only the growth past that offset; this metric adds the offset back so the budget accounts for it exactly once.",
  },
  latency_publish_ms: {
    label: "Latency · publish",
    description:
      "Component 2: muxed output → first confirmed write at the ingest server (same measurement as upload_latency_ms). One-shot per run, not a continuous series. Not RTT and not glass-to-glass.",
  },
  latency_network_ms: {
    label: "Latency · network",
    description:
      "Component 3: one-way path estimate, net_rtt_ms ÷ 2. Assumes a symmetric path. This is the only network figure every protocol can supply (libsrt, RTMP TCP probe, WebRTC ICE, MoQ qlog/probe), which is what makes the component comparable — but the underlying measurement differs per protocol, so treat cross-protocol differences of a few ms as noise.",
  },
  latency_packager_ms: {
    label: "Latency · packager",
    description:
      "Component 4: ingest → delivery-ready. Measured for MediaMTX LL-HLS from EXT-X-PROGRAM-DATE-TIME versus the encode anchor (folds in SRT tsbpd + network + remux). Zixi HTTP-TS is ~0 by construction (continuous TS, no packaging buffer). Zixi Fast HLS and MoQ have no direct measurement today, so their packaging time lands in the unattributed residual rather than being guessed at here.",
  },
  latency_player_buffer_ms: {
    label: "Latency · player buffer",
    description:
      "Component 5: delivery → glass. Media queued ahead of the playhead (HTMLMediaElement.buffered, or the WebRTC jitter buffer). Browser MoQ LOC renders to canvas and has no HTML buffer, so it contributes 0 here — its playback_buffer_sec column means 'seconds behind live', a different quantity that must not be summed into this chain.",
  },
  latency_accounted_ms: {
    label: "Latency · accounted",
    description:
      "Sum of the five latency components. Compare against e2e_latency_ms: close together means the decomposition explains the glass delay, far apart means it does not (see latency_residual_ms).",
  },
  latency_residual_ms: {
    label: "Latency · unattributed",
    description:
      "Measured glass delay minus the accounted components. This is a deliberate part of the model, not an error term to ignore: a large residual says the e2e estimate and the individual stages disagree, which is the signal to distrust a single-number comparison. Expected to be non-trivial on Zixi Fast HLS (unmeasured chunk packaging) and MoQ CMAF (group accumulation + join offset). Clamped at 0 — a negative value would mean components double-count, which is fixed at the source instead of displayed.",
  },
  encode_frames_total: {
    label: "Frames encoded",
    description: "Cumulative frames ffmpeg has written to the output muxer (-progress frame).",
  },
  encode_frames_dropped: {
    label: "Frames dropped (encode)",
    description:
      "Cumulative frames ffmpeg dropped rather than encode (-progress drop_frames). Exact, not inferred. The encoder-side counterpart to the player's dropped-frame counter: drops here mean the publish host could not keep up, and no downstream tuning will recover them.",
  },
  encode_frames_duped: {
    label: "Frames duplicated (encode)",
    description:
      "Cumulative frames ffmpeg duplicated to hold constant frame rate (-progress dup_frames), typically a VFR webcam normalized to CFR. Counted because a duplicated frame is not new content — a high dup count with a healthy fps means the source is starving the encoder.",
  },
  encode_frame_drop_pct: {
    label: "Frame drop % (encode)",
    description:
      "Encoder drops as a share of frames offered to the encoder (encoded + dropped). Deliberately not measured against fps × elapsed: a genuine 24fps source is not dropping 20% of a 30fps expectation.",
  },
  playback_frame_drop_pct: {
    label: "Frame drop % (playback)",
    description:
      "Viewer drops as a share of frames delivered to the player (rendered + dropped). Uses the same denominator convention as the encode-side percentage, which is what makes the two directly comparable rather than one being 'of expected' and the other 'of delivered'.",
  },
  frame_delivery_pct: {
    label: "Frame delivery %",
    description:
      "Painted frames as a share of encoded frames — the only frame metric spanning the whole chain, and the only one that catches loss in the middle (relay drop, packager gap, decoder flush) that neither endpoint counter sees on its own. 100% means every encoded frame reached the glass.",
  },
  e2e_latency_ms: {
    label: "Glass delay (estimated)",
    description:
      "Capture-to-glass delay in milliseconds, comparable across protocols. MoQ LOC: last painted frame's CaptureTimestamp (or path delay) plus stall time if the canvas is frozen — a stalled playhead must climb, never sit at a healthy ~30ms. WebRTC: encode time + RTT/2 + jitter buffer. HLS/HTTP-TS: clock-skew-corrected wall now minus the encoder-timeline playhead. Distinct from TTFF.",
  },
  playback_fps: {
    label: "Playback FPS",
    description:
      "Decoded frames rendered per second at the browser player, from the decoded-frame counter (or playa’s canvas counter for MoQ LOC). Compare with encode FPS to see whether the player is keeping up.",
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
      "Media Health (MoQ/CMAF): count of tfdt baseMediaDecodeTime jumps larger than the prior fragment duration (+ slack), tracked per track_ID with that track's own timescale (interleaved audio/video are independent timelines).",
  },
  cmaf_tfdt_gap_ms: {
    label: "CMAF decode-time gap",
    description:
      "Media Health (MoQ/CMAF): total (cumulative, not average) decode-time discontinuity duration in milliseconds across all tracks.",
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
      "Outbound rate in Mbps. CAUTION: on most paths (direct ffmpeg RTMP/SRT, MoQ) no transport-level send measurement exists and this is simply a copy of encoded_bitrate_kbps / 1000 — not an independent network measurement. Only srt-live-transmit (when enabled) supplies a measured libsrt send rate.",
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
    description:
      "Total payload bytes sent by the publisher during the benchmark window — the encoder's real cumulative muxed output (ffmpeg total_size) when available, otherwise the send rate integrated over actual sample intervals.",
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
    description:
      "Smoothed round-trip time from the moq5 publisher picoquic qlog (recovery/metrics_updated), in milliseconds. Reads 0 with the openmoq publisher (no qlog): the TCP-connect path probe used as a stand-in is reported under net_rtt_ms, not here — it is not a QUIC measurement.",
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
    description:
      "Cumulative viewer stalls after first frame — one count per HTML <video> waiting/frozen-playhead bracket (same definition for MoQ, HLS, MPEG-TS, DASH, WHEP). HLS also reports engine-specific BUFFER_STALLED events under playback_hls_buffer_stalls.",
  },
  playback_frames_rendered: {
    label: "Frames rendered",
    description: "Cumulative frames rendered reported by @playa/player stats during MoQ playback.",
  },
  playback_frames_dropped: {
    label: "Frames dropped",
    description:
      "Cumulative frames the viewer missed. For HLS/MPEG-TS/DASH/CMAF this is HTMLVideoElement droppedVideoFrames. For WebRTC it is RTC inbound-rtp framesDropped. For browser MoQ LOC, playa always reports 0, so the player infers missed frames as expected_fps × time_since_first_paint − frames_rendered.",
  },
  playback_bitrate_bps: {
    label: "Playback bitrate",
    description: "Receive bitrate in bits per second from @playa/player stats during MoQ playback.",
  },
  playback_ttff_ms: {
    label: "Time to first frame",
    description:
      "A single join event: milliseconds until the first rendered frame after the player goes live. It does not keep changing after first paint — not a continuous latency series.",
  },
  playback_buffer_sec: {
    label: "Buffer size",
    description:
      "Seconds of media queued ahead of the playhead for HLS/MPEG-TS/DASH (HTMLMediaElement.buffered) and WebRTC (RTC jitter buffer). Browser MoQ canvas has no HTML buffer — this is seconds the glass is behind the encode (missed frames / fps).",
  },
  playback_rebuffer_sec: {
    label: "Rebuffer time",
    description:
      "Cumulative seconds the player spent rebuffering after playback started — HTML <video> waiting→playing (plus frozen-playhead detection when waiting never fires). Same glass definition across MoQ / HLS / MPEG-TS / DASH / WHEP. A rising line means the viewer is seeing stalls; flat means smooth playback.",
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
    label: "Playhead (seconds of media on glass)",
    description:
      "Seconds of media the player has painted (max playhead). A healthy line tracks encode time (the chart x-axis) within about a second. A line that stops while wall/encode time keeps going is a freeze.",
  },
};

export function metricDefinition(key: string): MetricDefinition | undefined {
  return METRIC_DEFINITIONS[key];
}
