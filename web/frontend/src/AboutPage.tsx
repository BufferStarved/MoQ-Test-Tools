import { METRIC_DEFINITIONS } from "./metricDefinitions";
import { ArchStage, FlowArrow, FlowNode } from "./FlowDiagram";

const GH_REPO = "https://github.com/BufferStarved/MoQ-Test-Tools";
const GH_BLOB = `${GH_REPO}/blob/main`;
const GH_LOCAL_PUBLISHER = `${GH_BLOB}/docs/LOCAL-PUBLISHER.md`;
const GH_BYO_ENCODER = `${GH_BLOB}/docs/BYO-ENCODER.md`;

/** PayPal donate — hosted-button ID not required; business email is enough. */
export const PAYPAL_DONATE_URL =
  "https://www.paypal.com/donate/?business=sean.p.mccarthy92%40gmail.com&no_recurring=0&item_name=Help%20support%20this%20project&currency_code=USD";

/** Stable order for the About metric glossary (matches chart / scorecard groups). */
const ABOUT_METRIC_KEYS = [
  "encoded_bitrate_kbps",
  "fps",
  "fps_stability",
  "speed",
  "encode_lag_ms",
  "net_rtt_ms",
  "net_jitter_ms",
  "net_send_mbps",
  "net_recv_mbps",
  "net_loss_pct",
  "net_retrans_pct",
  "pkt_retrans",
  "pkt_fec_extra",
  "quic_packets_lost",
  "ts_continuity_counter_errors",
  "cmaf_seq_gap_count",
  "cmaf_tfdt_gap_count",
  "cmaf_parse_errors",
  "e2e_latency_ms",
  "playback_ttff_ms",
  "playback_stall_count",
  "playback_fps",
  "playback_buffer_sec",
  "playback_rebuffer_sec",
  "playback_frames_dropped",
  "vmaf_score",
  "psnr_db",
  "ssim",
  "vmaf_score_encoder",
  "vmaf_score_ingest",
  "total_bytes_sent",
  "peak_bandwidth_sent_mbps",
] as const;

export function AboutPage() {
  return (
    <section className="panel about-panel">
      <header className="about-header">
        <div>
          <h2>About MOQ Ingest Testing</h2>
          <p className="about-lede">
            A decision toolkit for streaming architects. Run the same encode against competing
            upload protocols and host locations, watch browser playback side by side, and leave with
            data for protocol choice, ingest placement, player selection, and config recipes.
          </p>
        </div>
        <div className="about-header-links">
          <a className="csv-download" href={GH_REPO} target="_blank" rel="noreferrer">
            GitHub repository
          </a>
          <a
            className="csv-download"
            href={PAYPAL_DONATE_URL}
            target="_blank"
            rel="noreferrer"
          >
            Help support this project
          </a>
        </div>
      </header>

      <section className="about-section about-decisions">
        <h3>Questions this site helps answer</h3>
        <div className="about-decision-grid">
          <div>
            <h4>Primary</h4>
            <ul className="about-list">
              <li>
                <strong>Which upload protocol?</strong> Compare SRT, RTMP, MoQ (and more as they
                land) under one wall-clock window.
              </li>
              <li>
                <strong>Where should I host ingest?</strong> Race Zixi, MediaMTX, OpenMOQ relay, or
                a custom origin in the same recipe.
              </li>
            </ul>
          </div>
          <div>
            <h4>Secondary</h4>
            <ul className="about-list">
              <li>
                <strong>Which player?</strong> Switch HLS, MoQ/Playa, WHEP, and MPEG-TS modes per
                stream and compare join time / stalls.
              </li>
              <li>
                <strong>What configs?</strong> Shared encode ladder + latency budget, plus per-stream
                publish / host / playback settings — exportable as CSV/JSON.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h3>Where ffmpeg runs (upload path)</h3>
        <p className="hint">
          The recipe couples source and encode location: Cloud playout always encodes on the API
          host (a live encode of a file); webcam always encodes on your laptop
          (realistic ISP/last-mile upload numbers).
        </p>
        <div className="about-encoder-grid">
          <article className="about-encoder-card">
            <h4>Cloud playout → API host</h4>
            <p>
              ffmpeg on the API host in GCP us-central1. Best for apples-to-apples
              protocol and player comparisons. Upload RTT / retrans charts reflect datacenter
              paths, not a home or studio network. You can upload your own file; it is encoded live like color bars.
            </p>
          </article>
          <article className="about-encoder-card recommended">
            <span className="about-encoder-badge">Realistic upload numbers</span>
            <h4>Webcam → this machine + agent</h4>
            <p>
              Choose <strong>Webcam</strong> in the recipe, start{" "}
              <code>./scripts/run-local-publisher.sh</code> against this site, then run the recipe
              once it shows &quot;Agent connected&quot; — ffmpeg on your laptop opens the camera and
              publishes over your real network. Full upload + playback metrics. See{" "}
              <a href={GH_LOCAL_PUBLISHER} target="_blank" rel="noreferrer">
                Local publisher guide
              </a>
              .
            </p>
          </article>
          <article className="about-encoder-card">
            <h4>Your own encoder</h4>
            <p>
              Point OBS, hardware, or your ffmpeg at our public publish URLs with the same ladder
              and latency settings as the UI. Playback metrics still work; upload charts need the
              agent or ingest telemetry. See{" "}
              <a href={GH_BYO_ENCODER} target="_blank" rel="noreferrer">
                BYO encoder settings
              </a>
              .
            </p>
          </article>
        </div>
      </section>

      <div className="about-contact">
        <h3>Contribute & contact</h3>
        <p>
          File bugs and feature requests on{" "}
          <a href={`${GH_REPO}/issues`} target="_blank" rel="noreferrer">
            GitHub Issues
          </a>
          . You can also reach out at{" "}
          <a href="mailto:me@sean-mccarthy.net">me@sean-mccarthy.net</a> or find{" "}
          <strong>Sean McCarthy</strong> on the{" "}
          <a href="https://video-dev.org/" target="_blank" rel="noreferrer">
            video-dev
          </a>{" "}
          Slack.
        </p>
        <p>
          Relay VMs and Zixi licenses add up.{" "}
          <a href={PAYPAL_DONATE_URL} target="_blank" rel="noreferrer">
            Help support this project
          </a>{" "}
          via PayPal if you want to offset compute and software costs.
        </p>
      </div>

      <section className="about-section">
        <h3>How comparisons stay fair</h3>
        <ul className="about-list">
          <li>
            Encode the <em>same</em> source (file or webcam) for every comparison leg under one
            wall-clock window.
          </li>
          <li>
            Publish over different ingest protocols and hosts, then observe transport, edge/relay,
            media integrity, playback, and optional VMAF side by side.
          </li>
          <li>
            Keep metrics comparable with a normalized model (`net_*`, media health, playback E2E)
            rather than protocol-specific charts only.
          </li>
          <li>
            Export CSV/JSON after each run, and reopen past sessions from the Results tab picker
            when you want to revisit a protocol or host trade-off.
          </li>
        </ul>
      </section>

      <section className="about-section">
        <h3>End-to-end architecture</h3>
        <p className="hint">
          Media path runs left → right: source and encode, then parallel ingest, then browser
          playback. Quality scoring runs on the ingest side.
        </p>
        <div className="flow-diagram">
          <ArchStage step="1" label="Source" tone="client">
            <FlowNode tone="client" title="Cloud playout" detail="Color bars, Big Buck Bunny, or your upload, encoded live" />
            <FlowNode tone="client" title="Webcam" detail="camera attached to your laptop" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="2" label="Encode" tone="server">
            <FlowNode tone="server" title="API host ffmpeg" detail="cloud playout on the API host" />
            <FlowNode
              tone="server"
              title="Laptop ffmpeg (agent)"
              detail="for webcam — AVFoundation/V4L2, or BYO encoder"
            />
            <FlowNode
              tone="server"
              title="Publish sidecars"
              detail="srt-live-transmit · openmoq-publisher"
            />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="3" label="Ingest" tone="transport">
            <FlowNode
              tone="transport"
              title="Zixi Broadcaster"
              detail="SRT/RTMP in · HLS :7777 · GCP (AWS/Linode presets planned)"
            />
            <FlowNode
              tone="transport"
              title="moqx relay"
              detail="WebTransport :4433 · MOQT draft-16"
            />
            <FlowNode
              tone="quality"
              title="Ingest agent (server-side)"
              detail="VMAF / PSNR / SSIM · CMAF · host metrics :8090"
            />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="4" label="Playback" tone="client">
            <FlowNode tone="client" title="HLS (hls.js)" detail="← Zixi Fast HLS egress" />
            <FlowNode tone="client" title="MoQ Playback (Playa)" detail="WebTransport ← moqx" />
          </ArchStage>
        </div>
        <ul className="about-list">
          <li>
            <strong>Where ffmpeg runs:</strong> Cloud playout always encodes on the API host (apples-to-
            apples protocol/player comparisons); webcam always encodes on your laptop via the
            publisher agent, so upload metrics reflect your real ISP/last-mile connection. You can
            also point your own encoder at our publish URLs — see the upload-path section above.
          </li>
          <li>
            <strong>VMAF:</strong> scored server-side by the ingest agent on the Zixi/relay worker —
            encoder capture and/or post-ingest recording.
          </li>
          <li>
            <strong>Multi-cloud:</strong> demo is GCP us-central1 today; presets/runbooks also cover
            AWS and Linode Zixi targets as they come online.
          </li>
        </ul>
      </section>

      <section className="about-section">
        <h3>Encode profile &amp; target latency</h3>
        <p className="hint">
          Upload configuration sets a shared bitrate ladder (360p–1080p) and a glass-to-glass
          latency budget (100–10 000 ms). That budget scales encoder GOP/VBV, SRT/Zixi latency,
          MoQ player catch-up, and HLS live buffer (2×2s segments = 4s default, down to 1s) for
          every comparison leg.
        </p>
        <p className="hint">
          <strong>SRT / RTMP in the browser:</strong> Chrome and other browsers cannot open{" "}
          <code>srt://</code> or <code>rtmp://</code> sockets. Preview uses a browser-safe path —
          Zixi HLS (default), MPEG-TS over HTTP, WHEP/WebRTC, or MoQ/WebTransport. True native
          SRT/RTMP players exist only as native apps or via a gateway that re-packages to one of
          those web transports.
        </p>
      </section>

      <section className="about-section">
        <h3>Client path</h3>
        <div className="flow-diagram flow-diagram-compact">
          <ArchStage step="1" label="Capture" tone="client">
            <FlowNode tone="client" title="Media source" detail="Cloud playout or agent-captured webcam" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="2" label="Jobs" tone="server">
            <FlowNode tone="server" title="Upload jobs" detail="SSE samples · Stop / cancel" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="3" label="Preview" tone="client">
            <FlowNode tone="client" title="MoQ Playback (Playa)" detail="WebTransport" />
            <FlowNode tone="client" title="HLS (hls.js)" detail="Zixi Fast HLS" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="4" label="Report" tone="client">
            <FlowNode tone="client" title="Results" detail="Verdict · TTFF · stalls · E2E · downloads" />
          </ArchStage>
        </div>
        <ul className="about-list">
          <li>
            Webcam is a live source, not a pre-recorded upload — the local publisher agent opens
            your camera directly with a 5‑minute safety cap and user Stop.
          </li>
          <li>
            Browsers cannot play raw SRT/RTMP; traditional legs preview via Zixi HLS. MoQ requires a
            WebTransport-capable browser (Chrome / Edge).
          </li>
          <li>
            Glass delay is comparable across protocols: MoQ LOC uses CaptureTimestamp at camera
            capture; WebRTC uses encode time + RTT/2 + jitter buffer; HLS/HTTP-TS uses wall clock
            minus the encoder-timeline playhead. Frozen playheads no longer inflate the series.
            TTFF stays a separate join metric.
          </li>
          <li>
            Every publish encode burns a documented clock into the video via ffmpeg{" "}
            <code>drawtext</code>: <code>encode time 00:01:23</code> is how far this frame is
            into the encode (file / webcam), and <code>capture time …Z</code> is wall-clock when
            the input already uses wall-clock PTS. It is not Unix-epoch + PTS mashed together.
            The laptop webcam preview overlay is labeled <code>wall clock</code> and is not
            mirrored.
          </li>
        </ul>
      </section>

      <section className="about-section">
        <h3>Transport & server path</h3>
        <div className="about-tech-grid">
          <article className="about-tech-card">
            <h4>SRT → Zixi</h4>
            <p>
              ffmpeg muxes MPEG-TS to localhost UDP; <code>srt-live-transmit</code> forwards to Zixi
              and supplies libsrt stats (RTT, retransmits, FEC). Zixi serves HLS for preview and can
              record for ingest VMAF.
            </p>
          </article>
          <article className="about-tech-card">
            <h4>MoQ → moqx</h4>
            <p>
              ffmpeg emits fragmented MP4; <code>openmoq-publisher</code> publishes over WebTransport
              to the moqx relay. Live sources skip <code>--paced</code> so objects track realtime;
              the player catch-up keeps playback near the live edge.
            </p>
          </article>
          <article className="about-tech-card">
            <h4>Ingest agent</h4>
            <p>
              HTTP sidecar on ingest/relay hosts for host metrics, recordings, CMAF integrity
              checks, and libvmaf. The web API orchestrates jobs and merges agent results into the
              summary JSON.
            </p>
          </article>
        </div>
      </section>

      <section className="about-section">
        <h3>Technologies</h3>
        <div className="about-table-wrap">
          <table className="about-table">
            <thead>
              <tr>
                <th>Layer</th>
                <th>Stack</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>UI</td>
                <td>React, Vite, Recharts, HLS.js, moq-playa</td>
              </tr>
              <tr>
                <td>API / orchestrator</td>
                <td>Python FastAPI, ffmpeg, srt-live-transmit, openmoq-publisher</td>
              </tr>
              <tr>
                <td>Traditional ingest</td>
                <td>Zixi Broadcaster (SRT/RTMP in, HLS out)</td>
              </tr>
              <tr>
                <td>MoQ ingest</td>
                <td>OpenMOQ / moqx relay (QUIC + WebTransport)</td>
              </tr>
              <tr>
                <td>Quality / integrity</td>
                <td>libvmaf, Zixi TR101, CMAF fragment checks</td>
              </tr>
              <tr>
                <td>Infra</td>
                <td>GCP Compute Engine, Caddy TLS, Terraform (moqx), cloud-init</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="about-section">
        <h3>Metric model</h3>
        <ol className="about-list numbered">
          <li>
            <strong>Encode/Publish</strong> — bitrate, frame rate, send rate, client memory,
            client network jitter, encode lag / speed / FPS stability, and encoder-side VMAF /
            PSNR / SSIM when enabled
          </li>
          <li>
            <strong>Ingest</strong> — path RTT / jitter / loss / retrans, server CPU/memory,
            protocol-native recovery (receive loss, FEC), and ingest-side VMAF / PSNR / SSIM when
            enabled
          </li>
          <li>
            <strong>Media health</strong> — TS continuity vs CMAF sequence / decode-time gaps
          </li>
          <li>
            <strong>Playback</strong> — TTFF, stalls, rebuffer time, buffer size, estimated
            glass-to-glass latency
          </li>
        </ol>
        <p className="hint about-metrics-doc-link">
          Full field reference:{" "}
          <a href={`${GH_BLOB}/docs/METRICS.md`} target="_blank" rel="noreferrer">
            docs/METRICS.md
          </a>{" "}
          on GitHub.
        </p>
        <dl className="about-metric-glossary">
          {ABOUT_METRIC_KEYS.map((key) => {
            const def = METRIC_DEFINITIONS[key];
            if (!def) {
              return null;
            }
            return (
              <div key={key} className="about-metric-glossary-row">
                <dt>
                  <code>{key}</code>
                  <span>{def.label}</span>
                </dt>
                <dd>{def.description}</dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section className="about-section">
        <h3>Implementation details</h3>
        <p className="hint">
          Deep dives live in the repo. Useful starting points:
        </p>
        <ul className="about-list links">
          <li>
            <a href={`${GH_BLOB}/docs/ARCHITECTURE.md`} target="_blank" rel="noreferrer">
              docs/ARCHITECTURE.md
            </a>{" "}
            — this overview in markdown
          </li>
          <li>
            <a href={`${GH_BLOB}/docs/METRICS.md`} target="_blank" rel="noreferrer">
              docs/METRICS.md
            </a>{" "}
            — field-level metric reference
          </li>
          <li>
            <a href={`${GH_BLOB}/src/upload_service.py`} target="_blank" rel="noreferrer">
              src/upload_service.py
            </a>{" "}
            — publish pipelines (SRT / MoQ / direct)
          </li>
          <li>
            <a href={`${GH_BLOB}/web/api/main.py`} target="_blank" rel="noreferrer">
              web/api/main.py
            </a>{" "}
            — HTTP API, jobs, playback proxy
          </li>
          <li>
            <a href={`${GH_BLOB}/web/frontend/src/players`} target="_blank" rel="noreferrer">
              web/frontend/src/players/
            </a>{" "}
            — MoQ & HLS players
          </li>
          <li>
            <a href={`${GH_BLOB}/ingest_agent`} target="_blank" rel="noreferrer">
              ingest_agent/
            </a>{" "}
            — recording, media health, VMAF
          </li>
          <li>
            <a href={`${GH_BLOB}/infra`} target="_blank" rel="noreferrer">
              infra/
            </a>{" "}
            — GCP runbooks for web, Zixi, and moqx
          </li>
        </ul>
      </section>
    </section>
  );
}
