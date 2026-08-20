import { useEffect, useMemo, useState } from "react";
import {
  chartGroupById,
  comparisonHasMetric,
  comparisonHasMetricPresent,
  comparisonSeries,
  comparisonVisibleGroups,
  buildComparisonPoints,
  ttffEventSummaries,
  type ComparisonLegData,
} from "./chartData";
import { MetricChart } from "./MetricChart";
import { ChartSectionNote } from "./ChartSectionNote";
import { metricUnavailableMessage, metricSupportedForProtocol, WHIP_ENCODE_BITRATE_NOTE, webrtcEncodeBitrateUnreported } from "./metricModel";
import { assignStreamColors } from "./protocolTheme";

interface ComparisonChartsProps {
  legs: ComparisonLegData[];
  /** Minimum legs with data before charts render (default 2 for live compare). */
  minLegs?: number;
}

function ProtocolAvailabilityNote({
  metricKey,
  legs,
}: {
  metricKey: string;
  legs: ComparisonLegData[];
}) {
  const unsupported = legs.filter((leg) => !metricSupportedForProtocol(metricKey, leg.protocol));
  if (unsupported.length === 0) {
    return null;
  }
  return (
    <p className="hint chart-availability-note">
      {unsupported
        .map((leg) => metricUnavailableMessage(metricKey, leg.protocol))
        .filter((value, index, all) => all.indexOf(value) === index)
        .join(" · ")}
    </p>
  );
}

export function ComparisonCharts({ legs, minLegs = 2 }: ComparisonChartsProps) {
  const activeLegs = legs.filter(
    (leg) => leg.samples.length > 0 || (leg.result?.rows?.length ?? 0) > 0,
  );
  const points = useMemo(() => buildComparisonPoints(activeLegs), [activeLegs]);
  const groups = useMemo(
    () => comparisonVisibleGroups(points, activeLegs),
    [points, activeLegs],
  );
  const [activeGroup, setActiveGroup] = useState(groups[0]?.id ?? "encode");

  useEffect(() => {
    if (!groups.some((group) => group.id === activeGroup)) {
      setActiveGroup(groups[0]?.id ?? "encode");
    }
  }, [groups, activeGroup]);

  const currentGroup = groups.find((group) => group.id === activeGroup) ?? groups[0];
  const encodeGroup = chartGroupById("encode");
  const clientGroup = chartGroupById("client");
  const ingestGroup = chartGroupById("ingest");
  const mediaHealthGroup = chartGroupById("media_health");
  const playbackGroup = chartGroupById("playback");
  const hasMoqLeg = activeLegs.some((leg) => leg.protocol === "moq");
  const hasBrowserMoqLeg = activeLegs.some(
    (leg) => leg.protocol === "moq" && (leg.publisherHost || "").toLowerCase() === "browser",
  );
  const qualityRequested = activeLegs.some((leg) => leg.qualityAnalysisRequested);
  const ttffLines = ttffEventSummaries(activeLegs, points);
  const hasSrtOrRtmpLeg = activeLegs.some(
    (leg) => leg.protocol === "srt" || leg.protocol === "rtmp",
  );
  const hasWebrtcLeg = activeLegs.some((leg) => leg.protocol === "webrtc");
  const whipBitrateMissing = activeLegs.some((leg) =>
    webrtcEncodeBitrateUnreported(
      leg.protocol,
      leg.samples,
      leg.result?.averages,
    ),
  );
  const streamColors = useMemo(
    () =>
      assignStreamColors(
        activeLegs.map((leg) => ({
          protocol: leg.protocol,
          ingestEndpointId: leg.ingestEndpointId,
          playbackMode: leg.playbackMode,
          endpoint: leg.endpoint,
        })),
      ),
    [activeLegs],
  );

  if (activeLegs.length < minLegs) {
    return (
      <div className="charts-empty muted">Waiting for uploads to produce telemetry...</div>
    );
  }

  if (points.length === 0 || !currentGroup) {
    return <div className="charts-empty muted">No comparison data yet.</div>;
  }

  return (
    <div className="charts-panel">
      <div className="charts-toolbar">
        <div className="chart-group-tabs">
          {groups.map((group) => (
            <button
              key={group.id}
              className={group.id === currentGroup.id ? "active" : ""}
              onClick={() => setActiveGroup(group.id)}
            >
              {group.title}
            </button>
          ))}
        </div>
        <span className="charts-meta">
          {points.length} seconds · {activeLegs.length} legs
        </span>
      </div>

      <div className="comparison-legend">
        {activeLegs.map((leg, index) => (
          <span key={leg.id} className="comparison-legend-item">
            <span className="comparison-swatch" style={{ background: streamColors[index] }} />
            {leg.label}
          </span>
        ))}
      </div>

      <div className="charts-grid">
        {currentGroup.id === "encode" && encodeGroup && (
          <>
            <ChartSectionNote
              title="Encode / publish (this host)"
              items={[
                "Bitrate and frame rate come from ffmpeg while publishing.",
                "Send rate is outbound publish throughput.",
                "Client memory is ffmpeg / publisher RSS on this machine.",
                "Client network jitter is RTT variation on the publisher side of the path.",
                "Encode lag, encode speed, and FPS stability come from ffmpeg progress while publishing.",
                "Picture-quality scores appear when Score picture quality is on.",
              ]}
            />
            <MetricChart
              title="Bitrate"
              metricKey="encoded_bitrate_kbps"
              data={points}
              series={comparisonSeries(activeLegs, "encoded_bitrate_kbps", "kbps")}
              caption="How many bits the encoder is producing each second."
            />
            {whipBitrateMissing ? (
              <p className="hint chart-availability-note">{WHIP_ENCODE_BITRATE_NOTE}</p>
            ) : activeLegs.some((leg) => leg.protocol === "webrtc") ? (
              <p className="hint chart-availability-note">
                WebRTC/WHIP bitrate often ramps for the first ~20–30s while
                the muxer warms up — expected, not a stall or a quality drop.
              </p>
            ) : null}
            {comparisonHasMetric(points, "encode_lag_ms", activeLegs.length) ? null : hasBrowserMoqLeg ? (
              <p className="hint chart-availability-note">
                Encode lag was not collected for browser MoQ (no ffmpeg
                progress). The WebCodecs queue vs capture clock should appear
                here on a new run.
              </p>
            ) : (
              <p className="hint chart-availability-note">
                Encode lag is hidden when every sample is 0 — either not
                collected, or the encoder stayed at its startup baseline
                (kept up with realtime).
              </p>
            )}
            <MetricChart
              title="Frame rate"
              metricKey="fps"
              data={points}
              series={comparisonSeries(activeLegs, "fps", "fps")}
              caption="Frames encoded per second — not what the glass painted. Check Playback FPS / dropped frames if the picture looks jumpy."
            />
            <MetricChart
              title="Send rate"
              metricKey="net_send_mbps"
              data={points}
              series={comparisonSeries(activeLegs, "net_send_mbps", "Mbps")}
              keepZeroSeries
              caption="How much this laptop is sending onto the network."
            />
            {comparisonHasMetric(points, "memory_mb", activeLegs.length) ? (
              <MetricChart
                title="Client memory"
                metricKey="memory_mb"
                data={points}
                series={comparisonSeries(activeLegs, "memory_mb", "MB")}
                caption="Publisher process memory on this machine."
              />
            ) : (
              <p className="hint chart-availability-note">
                Client memory (ffmpeg RSS) was not collected for this run — the
                series is hidden instead of plotting a flat zero.
              </p>
            )}
            <MetricChart
              title="Client network jitter"
              metricKey="net_jitter_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_jitter_ms", "ms")}
              caption="Publisher-side RTT variation. The first sample is often a connect-probe spike — ignore a lone 100ms+ blip at t=0."
            />
            {comparisonHasMetric(points, "encode_lag_ms", activeLegs.length) && (
              <MetricChart
                title="Encode lag"
                metricKey="encode_lag_ms"
                data={points}
                series={comparisonSeries(activeLegs, "encode_lag_ms", "ms")}
                keepZeroSeries
                caption="How far the encoder is behind capture/realtime. A flat near-zero means the encoder kept up — not a missing series."
              />
            )}
            {comparisonHasMetric(points, "fps_stability", activeLegs.length) && (
              <MetricChart
                title="FPS stability"
                metricKey="fps_stability"
                data={points}
                series={comparisonSeries(activeLegs, "fps_stability", "cv")}
              />
            )}
            {comparisonHasMetric(points, "speed", activeLegs.length) && (
              <MetricChart
                title="Encode speed"
                metricKey="speed"
                data={points}
                series={comparisonSeries(activeLegs, "speed", "x")}
              />
            )}
            {qualityRequested && comparisonHasMetric(points, "vmaf_score_encoder", activeLegs.length) && (
            <MetricChart
              title="VMAF (encoder)"
              metricKey="vmaf_score_encoder"
              data={points}
              series={comparisonSeries(activeLegs, "vmaf_score_encoder", "score")}
              yDomain={[0, 100]}
              caption="libvmaf score vs the source — only when Score picture quality was on."
            />
            )}
            {qualityRequested &&
              !comparisonHasMetric(points, "vmaf_score_encoder", activeLegs.length) &&
              activeLegs.some((leg) => leg.encoderQualityPending) && (
                <p className="hint chart-availability-note">
                  Picture-quality scores appear here when scoring finishes (after the encode).
                </p>
              )}
            {qualityRequested &&
              !comparisonHasMetric(points, "vmaf_score_encoder", activeLegs.length) &&
              !activeLegs.some((leg) => leg.encoderQualityPending) && (
                <p className="hint chart-availability-note">
                  Encoder VMAF was requested but this run was not scored
                  (browser/live/WHIP cannot tee a file reference).
                </p>
              )}
            {qualityRequested && comparisonHasMetric(points, "psnr_db_encoder", activeLegs.length) && (
            <MetricChart
              title="PSNR"
              metricKey="psnr_db_encoder"
              data={points}
              series={comparisonSeries(activeLegs, "psnr_db_encoder", "dB")}
            />
            )}
            {qualityRequested && comparisonHasMetric(points, "ssim_encoder", activeLegs.length) && (
            <MetricChart
              title="SSIM"
              metricKey="ssim_encoder"
              data={points}
              series={comparisonSeries(activeLegs, "ssim_encoder", "score")}

              yDomain={[0, 1]}
            />
            )}
          </>
        )}

        {currentGroup.id === "client" && clientGroup && (
          <>
            <MetricChart
              title="Process CPU"
              metricKey="cpu_percent"
              data={points}
              series={comparisonSeries(activeLegs, "cpu_percent", "%")}
            />
            <MetricChart
              title="Process memory"
              metricKey="memory_mb"
              data={points}
              series={comparisonSeries(activeLegs, "memory_mb", "MB")}
            />
          </>
        )}

        {currentGroup.id === "ingest" && ingestGroup && (
          <>
            <ChartSectionNote
              title="Ingest path"
              items={[
                "Shared across MoQ / SRT / RTMP: ingest-host CPU & memory, plus path loss% and retransmit%.",
                "SRT RTT: libsrt / Zixi receiver.",
                "RTMP RTT: Zixi receiver when available; otherwise a TCP probe to the RTMP host:port.",
                "ICE RTT from WHIP when publishing from the browser.",
                "Protocol panels below are native counters (MoQ relay Δ, SRT / Zixi recovery).",
              ]}
            />
            <MetricChart
              title="RTT"
              metricKey="net_rtt_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_rtt_ms", "ms")}
            />
            <MetricChart
              title="Server network jitter"
              metricKey="net_jitter_ms"
              data={points}
              series={comparisonSeries(activeLegs, "net_jitter_ms", "ms")}
            />
            <MetricChart
              title="Server CPU"
              metricKey="server_cpu_percent"
              data={points}
              series={comparisonSeries(activeLegs, "server_cpu_percent", "%")}
            />
            <MetricChart
              title="Server memory"
              metricKey="server_memory_percent"
              data={points}
              series={comparisonSeries(activeLegs, "server_memory_percent", "%")}
            />
            <MetricChart
              title="Path loss %"
              metricKey="net_loss_pct"
              data={points}
              series={comparisonSeries(activeLegs, "net_loss_pct", "%")}
              keepZeroSeries
            />
            <MetricChart
              title="Retransmit %"
              metricKey="net_retrans_pct"
              data={points}
              series={comparisonSeries(activeLegs, "net_retrans_pct", "%")}
              keepZeroSeries
            />
            {hasMoqLeg && (
              <>
                <MetricChart
                  title="Receive loss"
                  metricKey="quic_packets_lost"
                  data={points}
                  series={comparisonSeries(activeLegs, "quic_packets_lost", "pkts")}
                  keepZeroSeries
                />
                {comparisonHasMetric(points, "quic_cwnd_bytes", activeLegs.length) && (
                  <MetricChart
                    title="QUIC congestion window"
                    metricKey="quic_cwnd_bytes"
                    data={points}
                    series={comparisonSeries(activeLegs, "quic_cwnd_bytes", "bytes")}
                  />
                )}
              </>
            )}
            {hasSrtOrRtmpLeg && (
              <MetricChart
                title="FEC extra"
                metricKey="pkt_fec_extra"
                data={points}
                series={comparisonSeries(activeLegs, "pkt_fec_extra", "pkts")}
                keepZeroSeries
              />
            )}
            {qualityRequested && comparisonHasMetric(points, "vmaf_score_ingest", activeLegs.length) && (
            <MetricChart
              title="VMAF (ingest)"
              metricKey="vmaf_score_ingest"
              data={points}
              series={comparisonSeries(activeLegs, "vmaf_score_ingest", "score")}
              yDomain={[0, 100]}
              caption="libvmaf after the network path — only when Score picture quality was on."
            />
            )}
            {qualityRequested &&
              !comparisonHasMetric(points, "vmaf_score_ingest", activeLegs.length) &&
              activeLegs.some((leg) => leg.ingestQualityPending) && (
                <p className="hint chart-availability-note">
                  Destination picture-quality scores appear here after the remote recorder finishes.
                </p>
              )}
            {qualityRequested &&
              !comparisonHasMetric(points, "vmaf_score_ingest", activeLegs.length) &&
              !activeLegs.some((leg) => leg.ingestQualityPending) && (
                <p className="hint chart-availability-note">
                  Ingest VMAF was requested but this destination was not scored.
                </p>
              )}
            {qualityRequested && comparisonHasMetric(points, "psnr_db_ingest", activeLegs.length) && (
            <MetricChart
              title="PSNR (ingest)"
              metricKey="psnr_db_ingest"
              data={points}
              series={comparisonSeries(activeLegs, "psnr_db_ingest", "dB")}
            />
            )}
            {qualityRequested && comparisonHasMetric(points, "ssim_ingest", activeLegs.length) && (
            <MetricChart
              title="SSIM (ingest)"
              metricKey="ssim_ingest"
              data={points}
              series={comparisonSeries(activeLegs, "ssim_ingest", "score")}

              yDomain={[0, 1]}
            />
            )}
          </>
        )}

        {currentGroup.id === "media_health" && mediaHealthGroup && (
          <>
            <ChartSectionNote
              title="Media container integrity"
              items={[
                "Measures timeline and container health — not network transport.",
                "MPEG-TS (SRT/RTMP): Zixi TR101 continuity-counter errors.",
                "MoQ CMAF: fragment sequence gaps, decode-time gaps, and parse errors.",
              ]}
            />
            <ProtocolAvailabilityNote metricKey="ts_continuity_counter_errors" legs={activeLegs} />
            <ProtocolAvailabilityNote metricKey="cmaf_seq_gap_count" legs={activeLegs} />
            {comparisonHasMetric(points, "ts_continuity_counter_errors", activeLegs.length) && (
              <MetricChart
                title="TS continuity errors"
                metricKey="ts_continuity_counter_errors"
                data={points}
                series={comparisonSeries(activeLegs, "ts_continuity_counter_errors", "count")}
              />
            )}
            {comparisonHasMetric(points, "cmaf_seq_gap_count", activeLegs.length) && (
              <MetricChart
                title="CMAF sequence gaps"
                metricKey="cmaf_seq_gap_count"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_seq_gap_count", "count")}
              />
            )}
            {comparisonHasMetric(points, "cmaf_tfdt_gap_count", activeLegs.length) && (
              <MetricChart
                title="CMAF decode-time gaps"
                metricKey="cmaf_tfdt_gap_count"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_tfdt_gap_count", "count")}
              />
            )}
            {comparisonHasMetric(points, "cmaf_tfdt_gap_ms", activeLegs.length) && (
              <MetricChart
                title="CMAF decode-time gap (ms)"
                metricKey="cmaf_tfdt_gap_ms"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_tfdt_gap_ms", "ms")}
              />
            )}
            {comparisonHasMetric(points, "cmaf_parse_errors", activeLegs.length) && (
              <MetricChart
                title="CMAF parse errors"
                metricKey="cmaf_parse_errors"
                data={points}
                series={comparisonSeries(activeLegs, "cmaf_parse_errors", "count")}
              />
            )}
          </>
        )}

        {currentGroup.id === "playback" && playbackGroup && (
          <>
            {comparisonHasMetric(points, "e2e_latency_ms", activeLegs.length) && (
              <MetricChart
                title="Glass delay (estimated)"
                metricKey="e2e_latency_ms"
                data={points}
                series={comparisonSeries(activeLegs, "e2e_latency_ms", "ms")}
                caption="Capture-to-glass delay. A healthy live line stays roughly flat; a climb usually means a frozen playhead, not growing glass latency."
              />
            )}
            {comparisonHasMetric(points, "playback_ttff_ms", activeLegs.length) && (
              <p className="hint chart-availability-note">
                Time to first frame is a single join event, not ongoing latency.
                {" "}
                {ttffLines.join(" · ")}
                . After first paint this value does not change.
              </p>
            )}
            <MetricChart
              title="Playback FPS"
              metricKey="playback_fps"
              data={points}
              series={comparisonSeries(activeLegs, "playback_fps", "fps")}
              keepZeroSeries
              caption="Frames the player actually painted. Encode FPS can look perfect while this drops."
            />
            <MetricChart
              title="Frames dropped"
              metricKey="playback_frames_dropped"
              data={points}
              series={comparisonSeries(activeLegs, "playback_frames_dropped", "frames")}
              keepZeroSeries
              caption="Cumulative glass-side drops (HTML video quality, playa, or WHEP RTC stats). Rising means the viewer missed frames."
            />
            {(comparisonHasMetricPresent(points, "playback_stall_count", activeLegs.length) ||
              comparisonHasMetric(points, "playback_ttff_ms", activeLegs.length) ||
              comparisonHasMetric(points, "playback_video_time_sec", activeLegs.length)) && (
              <MetricChart
                title="Playback stalls"
                metricKey="playback_stall_count"
                data={points}
                series={comparisonSeries(activeLegs, "playback_stall_count", "count")}
                keepZeroSeries
                caption="How many times the playhead froze after first frame. Flat zero is smooth playback."
              />
            )}
            {comparisonHasMetric(points, "playback_rebuffer_sec", activeLegs.length) && (
              <MetricChart
                title="Rebuffer time"
                metricKey="playback_rebuffer_sec"
                data={points}
                series={comparisonSeries(activeLegs, "playback_rebuffer_sec", "s")}
                keepZeroSeries
              />
            )}
            {(comparisonHasMetric(points, "playback_buffer_sec", activeLegs.length) ||
              comparisonHasMetricPresent(points, "playback_buffer_sec", activeLegs.length) ||
              hasWebrtcLeg) && (
              <MetricChart
                title="Buffer size"
                metricKey="playback_buffer_sec"
                data={points}
                series={comparisonSeries(activeLegs, "playback_buffer_sec", "s")}
                keepZeroSeries
                caption="Seconds queued ahead of the playhead. WebRTC/WHEP is the jitter buffer (RTCRtpReceiver jitterBufferDelay), not HLS buffered ranges."
              />
            )}
            {comparisonHasMetric(points, "playback_video_time_sec", activeLegs.length) && (
              <MetricChart
                title="Playhead (seconds of media on glass)"
                metricKey="playback_video_time_sec"
                data={points}
                series={comparisonSeries(activeLegs, "playback_video_time_sec", "s")}
                caption="Seconds of media the player has painted. A healthy line tracks encode time (the x-axis) within about a second. A line that stops while the x-axis keeps going is a freeze."
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
