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
      "Component 2: muxed output → ingest, per sample. No protocol produces this measurement yet, so it reads 0 and 'publish' is listed in latency_unmeasured on every leg. It is deliberately NOT upload_latency_ms: that is a one-shot startup figure (encoder-ready → first confirmed publish), and adding a startup constant to every steady-state sample used to inflate the accounted total for a whole run. Read upload_latency_ms in its own column for the startup number.",
  },
  latency_network_ms: {
    label: "Latency · network",
    description:
      "Component 3: one-way path estimate, net_rtt_ms ÷ 2. Assumes a symmetric path. Available on SRT (libsrt), RTMP (TCP connect probe) and WebRTC (ICE currentRoundTripTime) — the underlying measurement differs per protocol, so treat cross-protocol differences of a few ms as noise. MoQ has no RTT source wired: the openmoq publisher emits no qlog and the relay admin TCP port the probe targets is not reachable, so MoQ legs list 'network' in latency_unmeasured instead of reporting a 0 ms hop.",
  },
  latency_packager_ms: {
    label: "Latency · packager",
    description:
      "Component 4: ingest → delivery-ready. Measured for MediaMTX LL-HLS from EXT-X-PROGRAM-DATE-TIME versus the encode anchor (folds in SRT tsbpd + network + remux). Zixi HTTP-TS is a measured ~0 by construction (continuous TS, no packaging buffer). Zixi Fast HLS carries no PDT and MoQ has no packager clock, so on those legs there is no instrument at all: they list 'packager' in latency_unmeasured and their packaging time is part of the residual. A 0 here with 'packager' unmeasured means unknown, not free.",
  },
  latency_player_buffer_ms: {
    label: "Latency · player buffer",
    description:
      "Component 5: delivery → glass. Media queued AHEAD of the playhead (HTMLMediaElement.buffered, or the WebRTC jitter buffer). Browser MoQ LOC renders to canvas and has no HTML buffer, so it contributes 0 — its 'seconds behind live' figure is the opposite direction and travels in playback_behind_live_sec, which is never summed into this chain. Unmeasured (and listed as such) for any sample where the player was not reporting.",
  },
  latency_accounted_ms: {
    label: "Latency · accounted",
    description:
      "Sum of the latency components that this leg's e2e estimator actually spans — see latency_e2e_scope. Compare against e2e_latency_ms: close together means the decomposition explains the glass delay; the gap in either direction is split into latency_residual_ms and latency_overcount_ms.",
  },
  latency_residual_ms: {
    label: "Latency · unattributed",
    description:
      "Measured glass delay the accounted components do not explain. A deliberate part of the model, not an error term to ignore: a large residual says the e2e estimate and the individual stages disagree, which is the signal to distrust a single-number comparison. Check latency_unmeasured first — on Zixi legs the residual is largely the packager stage, which has no instrument rather than being zero. Never negative: components exceeding the measurement is a different fact and is reported in latency_overcount_ms.",
  },
  latency_overcount_ms: {
    label: "Latency · over-attributed",
    description:
      "How far the accounted components exceed measured glass delay. Non-zero means the model double-counts or mixes measurement spans somewhere, which is a bug to fix at the source — but it can only be fixed if it is visible. This column exists because the residual alone was clamped at 0, which made a leg over-attributing by 1.7 s look exactly like one that reconciled perfectly. Exactly one of this and latency_residual_ms can be non-zero.",
  },
  latency_unmeasured: {
    label: "Latency · unmeasured stages",
    description:
      "Which pipeline stages have no instrument on this leg, comma separated. A component reading 0.0 means 'measured, and it was zero' only if it is absent from this list; if it is present, 0.0 means 'nothing measures this here' and the time is inside the residual. Today: 'publish' on every leg, 'packager' on Zixi and MoQ, 'network' on MoQ, 'player_buffer' on samples where the browser was not reporting.",
  },
  latency_e2e_scope: {
    label: "Latency · e2e scope",
    description:
      "Which span this leg's e2e_latency_ms actually measures, and therefore which components may be summed against it. 'capture_to_glass' (HLS PDT, HTTP-TS, MoQ) includes the sender's encode pipeline, so all five stages are in scope. 'ingest_to_glass' (WHEP) is a receiver-side estimate built from ICE RTT/2 plus jitterBufferDelay and structurally cannot see the sender: latency_encode_ms is still reported there so the operator knows the pipeline exists, but it is excluded from the accounted total. Two legs with different scopes are not measuring the same thing — a WHEP number is not comparable to an HLS number without adding the encode column back.",
  },
  startup_dns_ms: {
    label: "Startup · DNS",
    description:
      "Publisher phase 1 of 6: job start → the ingest hostname resolved. getaddrinfo() timed in the preflight probe on every protocol — RTMP/SRT on the ingest host, WHIP on the WHIP host, MoQ on the relay host. Phases are durations, not offsets from t0: this is the cost of resolution itself, not the distance from job start. A warm resolver cache genuinely reads 0.0, which is a measurement; blank is the value that means nothing measured it.",
  },
  startup_connect_ms: {
    label: "Startup · connect",
    description:
      "Publisher phase 2: resolved address → transport connected. RTMP: TCP connect to the RTMP port (1935), timed in the preflight probe. WHIP: TCP/TLS connect to the WHIP endpoint (8889), same probe. MoQ: the QUIC handshake, which folds transport and crypto into one exchange, so it is mapped here and the WebTransport session that follows is mapped to handshake. SRT: not applicable — there is no separate transport connect over UDP to time, its caller handshake IS the connect, so SRT names 'connect' in startup_not_applicable and the time lands in startup_handshake_ms. Not-applicable is not unmeasured: there is no instrument to go looking for.",
  },
  startup_handshake_ms: {
    label: "Startup · handshake",
    description:
      "Publisher phase 3: transport connected → the protocol session is up. RTMP: C0/C1/S0/S1/S2 plus connect/createStream/publish. SRT: the caller handshake including key material exchange — and SRT's connect phase is folded in here, reported as not-applicable rather than zero, which is what keeps this column comparable with RTMP's 'after the socket, before publish is accepted'. WHIP: ICE establishment and DTLS setup. MoQ: the WebTransport session established over the already-completed QUIC handshake.",
  },
  startup_publish_accept_ms: {
    label: "Startup · publish accept",
    description:
      "Publisher phase 4: session up → the ingest confirmed it will accept the publish. RTMP/SRT: the ingest reports the input live (Zixi input ready / MediaMTX path ready). WHIP: the POST offer returning 201 Created with the answer SDP — that response IS the accept, so WHIP has no separate accept round trip. MoQ: SETUP/ANNOUNCE accepted and the catalog published ('sender ready (namespace + catalog published)'). A slow ingest, a rejected key, or an ingest waiting on packaging all land here rather than being smeared across the neighbouring phases.",
  },
  startup_first_idr_ms: {
    label: "Startup · first IDR",
    description:
      "Publisher phase 5: publish accepted → the encoder emitted its first frame, which for H.264 is an IDR. The same instrument on all four protocols (the encoder's own first output), which makes it the one publisher phase directly comparable across legs. GOP structure is paid here: the RTMP 23s → 1501 ms win came from decoupling the GOP from the HLS chunk duration, and a long keyframe interval is charged once here and again at the player's first media.",
  },
  startup_first_byte_ingest_ms: {
    label: "Startup · first byte at ingest",
    description:
      "Publisher phase 6, the last: first frame encoded → the ingest confirmed bytes on the path. RTMP: ingest reports bytes received on the path. SRT: libsrt reports a non-zero send rate, or the ingest reports bytes received. WHIP: MediaMTX reports bytes received (first RTP landed). MoQ: the first object on the wire ('obj vide wall_dt_ms='). This is where the publisher chain ends, and startup_publisher_measured_ms is job start to exactly this point. Distinct from upload_latency_ms, which measures encoder-ready → first confirmed write as one opaque number with no phase breakdown.",
  },
  startup_player_request_ms: {
    label: "Startup · player request",
    description:
      "Player phase 1 of 4: the player attached → its first request is on the wire. HLS/LL-HLS/DASH: Resource Timing on the manifest or MPD request, fetchStart → requestStart, which folds in DNS, connect and TLS for the playback path. MPEG-TS: the same marks on the TS request. WHEP: the same marks on the WHEP POST. MoQ: playa's load() → WebTransport session connected. This chain starts at player attach, not at job start — the operator's dwell before opening the tile belongs to neither pipeline and is deliberately inside neither total.",
  },
  startup_manifest_ms: {
    label: "Startup · manifest",
    description:
      "Player phase 2: request on the wire → a manifest or catalog in hand. HLS/LL-HLS: Resource Timing on the manifest, requestStart → responseEnd. DASH: the same on the MPD. WHEP: the SDP exchange, POST offer → 201 answer (responseEnd). MoQ: playa's SETUP complete → catalog received (SUBSCRIBE, plus the joining FETCH). Raw MPEG-TS playback: not applicable — a TS pull has no manifest at all, the first response IS the media, and a 0 ms manifest would imply an instant fetch of something that does not exist. It is named in startup_not_applicable, never in startup_unmeasured.",
  },
  startup_first_media_ms: {
    label: "Startup · first media",
    description:
      "Player phase 3: manifest or catalog → the first media has arrived and the decoder is configured. HLS/DASH: the first media segment response completes. LL-HLS: the first partial segment. MPEG-TS: the first bytes of the TS response (responseStart). WHEP: getStats() shows the ICE candidate pair succeeded and DTLS connected, then the first inbound-rtp bytes. MoQ: playa's first group/object received, then decoder configured. Segment and group duration are paid here: this is the phase that held the 23-second RTMP join, because nothing was decodable until a whole HLS chunk had been packaged.",
  },
  startup_first_paint_ms: {
    label: "Startup · first paint",
    description:
      "Player phase 4, the last: first media → the first frame on glass. HLS/LL-HLS/MPEG-TS/DASH: currentTime advances past the session origin. WHEP: first frame painted. MoQ: playa's first frame rendered to the canvas. Decoder start-up and the player's own gate live here. Because the player chain reconciles against playback_ttff_ms, a blank here does not make the TTFF disappear — it moves into startup_player_residual_ms, which is the signal that this phase has no instrument on that engine yet.",
  },
  startup_publisher_accounted_ms: {
    label: "Startup · publisher accounted",
    description:
      "Sum of the six publisher phases that actually have a reading. Compare against startup_publisher_measured_ms: close together means the chain explains the whole publisher startup, and the gap in either direction is split into startup_publisher_residual_ms and startup_publisher_overcount_ms. Blank phases contribute nothing, so a small accounted total beside a large measured one means instruments are missing (read startup_unmeasured) — it does not mean startup was fast.",
  },
  startup_publisher_measured_ms: {
    label: "Startup · publisher measured",
    description:
      "The publisher chain's measured total: job start → first media confirmed at the ingest. This is the number the six publisher phases reconcile against, and it is deliberately never added to the player total. Between 'ingest has the first byte' and 'an operator opened the tile' sits dwell time belonging to neither pipeline, so a joined 'total startup' would be dominated by human reaction time. Blank when either end of the span was never observed — blank, not 0, because a job that never confirmed ingest did not start up instantly.",
  },
  startup_publisher_residual_ms: {
    label: "Startup · publisher unattributed",
    description:
      "Measured publisher startup the six phases do not explain. A deliberate part of the model rather than an error term to ignore: a large residual says which part of the chain has no instrument, and startup_unmeasured names it. It is also the honest home for a phase whose bounding milestone was missing — the model refuses to stretch a neighbouring phase across the gap, because that silently moves real time into whichever phase happened to have an instrument. Never negative: phases exceeding the measurement is a different fact and lands in startup_publisher_overcount_ms.",
  },
  startup_publisher_overcount_ms: {
    label: "Startup · publisher over-attributed",
    description:
      "How far the publisher phases exceed the measured publisher total. Non-zero means two phases share a span somewhere — a modelling bug, but one an operator can only find if the column admits it. It exists for the same reason latency_overcount_ms does: with the residual alone clamped at 0, a leg over-attributing by 1.7 s looked exactly like one that reconciled perfectly. Exactly one of this and startup_publisher_residual_ms can be non-zero.",
  },
  startup_player_accounted_ms: {
    label: "Startup · player accounted",
    description:
      "Sum of the four player phases that actually have a reading. Compare against startup_player_measured_ms (which is playback_ttff_ms): together they turn a single join number into an attribution. A phase reported as not-applicable contributes nothing and is not a gap — its time is inside the phase that genuinely contains it, so an MPEG-TS leg reconciles with three phases rather than four.",
  },
  startup_player_measured_ms: {
    label: "Startup · player measured",
    description:
      "The player chain's measured total, which is playback_ttff_ms: player attach → first painted frame. This is what the four player phases reconcile against. It is a single join event, not a series, and it is not comparable with startup_publisher_measured_ms — the two spans do not touch. Blank when no frame ever painted, which is why an all-black tile shows a blank total rather than a confident 0.",
  },
  startup_player_residual_ms: {
    label: "Startup · player unattributed",
    description:
      "Measured time-to-first-frame the four player phases do not explain. This is the column that made the RTMP investigation reproducible: a 23-second TTFF with almost all of it unattributed points straight at the phases with no instrument, and the phases that do have one rule themselves out. Read startup_unmeasured alongside it. Never negative — over-attribution is startup_player_overcount_ms.",
  },
  startup_player_overcount_ms: {
    label: "Startup · player over-attributed",
    description:
      "How far the player phases exceed measured TTFF. On the player side this usually means two phases were derived from overlapping browser marks (Resource Timing spans that nest, or a getStats() transition already counted in the SDP exchange), which is a mapping bug to fix at the source. Exactly one of this and startup_player_residual_ms can be non-zero.",
  },
  startup_unmeasured: {
    label: "Startup · unmeasured phases",
    description:
      "Which startup phases had no instrument on this leg, comma separated, in chain order, using the short stage names (dns, connect, handshake, publish_accept, first_idr, first_byte_ingest, player_request, manifest, first_media, first_paint). A phase column that is blank and named here means 'nothing measures this here'; a phase reading 0.0 means 'measured, and it was zero'. Those are different facts and the CSV keeps them apart, which is why an unmeasured phase is blank rather than zero. This list is the first thing to read when a residual is large. A phase that structurally cannot exist on this protocol is not here — it is in startup_not_applicable.",
  },
  startup_not_applicable: {
    label: "Startup · not-applicable phases",
    description:
      "Which startup phases structurally do not exist on this protocol or player engine, comma separated. The third state, and not a synonym for unmeasured: SRT has no TCP connect (its caller handshake IS the connect) and a raw MPEG-TS pull has no manifest (the first response IS the media). Calling those unmeasured would send an operator hunting for an instrument that cannot exist; calling them 0.0 would claim an exchange completed instantly. Their time is not lost — the chain anchors the next phase to the last milestone that did happen, so an n/a phase's duration is attributed to the phase that genuinely contains it (SRT's handshake is timed from DNS completion and spans the whole caller exchange).",
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
      "Painted frames as a share of encoded frames over the window the player was actually attached for — the only frame metric spanning the whole chain, and the only one that catches loss in the middle (relay drop, packager gap, decoder flush) that neither endpoint counter sees on its own. 100% means every frame encoded since the player attached reached the glass. Both counters are differenced against their value at attach, because they are cumulative from different zero points: dividing the raw totals measured how late the browser attached, not delivery. Blank means there is no shared window yet (or the player has stopped reporting), which is unknown rather than zero. Not capped at 100% — a player reading ahead of the encoder counter is clock skew, and hiding that behind a perfect score is what a cap would do.",
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
      "Seconds of media queued AHEAD of the playhead: HTMLMediaElement.buffered for HLS/MPEG-TS/DASH and MoQ CMAF-over-MSE, or the jitter buffer for WebRTC. The only quantity the latency budget's player-buffer stage consumes. Read it with the playhead: a large value while playback_video_time_sec advances is a deep safety buffer, but the same value while the playhead is frozen is delivered media the decoder never drained — a stall, not headroom. A MoQ LOC canvas has no HTML buffer and reports 0 here; its 'behind live' figure is a different quantity in playback_behind_live_sec.",
  },
  playback_behind_live_sec: {
    label: "Seconds behind live",
    description:
      "How far the glass trails the encoder, for the browser MoQ LOC canvas only (missed frames / fps). This is the OPPOSITE direction from playback_buffer_sec, which is why it has its own column and is never summed into the latency chain — adding it there once charted a 10.9s 'buffer' on the protocol that should have been the lowest-latency one. Blank or 0 on every engine that owns a real HTMLMediaElement.",
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
