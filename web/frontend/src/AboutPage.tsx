import type { ReactNode } from "react";
import { METRIC_DEFINITIONS } from "./metricDefinitions";

const GH_REPO = "https://github.com/BufferStarved/MoQ-Test-Tools";
const GH_BLOB = `${GH_REPO}/blob/main`;

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

function FlowArrow() {
  return <span className="about-flow-arrow" aria-hidden="true">→</span>;
}

function FlowNode({
  title,
  detail,
  tone = "default",
}: {
  title: string;
  detail?: string;
  tone?: "default" | "client" | "transport" | "server" | "quality";
}) {
  return (
    <div className={`about-flow-node tone-${tone}`}>
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

function ArchStage({
  step,
  label,
  tone,
  children,
}: {
  step: string;
  label: string;
  tone: "client" | "server" | "transport" | "quality";
  children: ReactNode;
}) {
  return (
    <div className={`about-arch-stage tone-${tone}`}>
      <div className="about-arch-stage-label">
        <span className="about-arch-step">{step}</span>
        {label}
      </div>
      <div className="about-arch-stage-body">{children}</div>
    </div>
  );
}

export function AboutPage() {
  return (
    <section className="panel about-panel">
      <header className="about-header">
        <div>
          <h2>About MOQ Ingest Testing</h2>
          <p className="about-lede">
            An open benchmark platform for comparing live video ingest — especially{" "}
            <strong>MoQ over WebTransport</strong> against traditional paths such as{" "}
            <strong>SRT / RTMP into Zixi</strong> — with shared encodes, normalized metrics, and
            browser playback.
          </p>
        </div>
        <a className="csv-download" href={GH_REPO} target="_blank" rel="noreferrer">
          GitHub repository
        </a>
      </header>

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
      </div>

      <section className="about-section">
        <h3>MediaMTX LL-HLS / LL-DASH / WHEP delivery</h3>
        <p>
          For standards low-latency delivery (separate from Zixi Fast HLS), pick ingest endpoint{" "}
          <strong>MediaMTX gcp-us-central1 (LL-HLS / WHEP)</strong> and publish SRT, RTMP, or WHIP.
          Playback: <strong>LL-HLS</strong> (MediaMTX native), <strong>LL-DASH</strong> (ffmpeg CMAF
          sidecar → nginx :8891), or <strong>WHEP</strong>. See{" "}
          <a
            href={`${GH_BLOB}/infra/mediamtx/GCP-MEDIAMTX-RUNBOOK.md`}
            target="_blank"
            rel="noreferrer"
          >
            GCP-MEDIAMTX-RUNBOOK.md
          </a>
          .
        </p>
      </section>

      <section className="about-section">
        <h3>Zixi Fast HLS (packager timeline)</h3>
        <p>
          Fast HLS builds a lightweight packager on the first playlist request and{" "}
          <strong>reuses it across SRT reconnects</strong>. File publishes that rewind PTS behind
          that packager&apos;s high-water mark stall the playlist (
          <code>media_sequence</code> frozen / <code>chunk=0</code> 404) even while ingest looks
          healthy. RTMP looks more stable because Zixi starts a <em>fresh</em> packager per RTMP
          publish.
        </p>
        <p>
          This site applies a monotonic ffmpeg <code>-output_ts_offset</code> on managed Zixi SRT
          publishes so each session starts above the previous timeline (no delete+recreate
          required). Mid-job heal may still reset the SRT input if the playlist wedges. For
          ultra-low-latency monitor / VMAF pulls, use playback mode{" "}
          <strong>MPEG-TS over HTTP</strong> (
          <code>http://&lt;zixi&gt;:7777/&lt;stream&gt;.ts</code>, requires{" "}
          <code>http_ts_auto_out=1</code>) — it bypasses the HLS packager entirely.
        </p>
        <p>
          The <strong>HLS / DASH</strong> Zixi presets push MPEG-TS over HTTP PUT to{" "}
          <code>/benchmark</code>. Per-input DASH MPD is not served without an adaptive group; the
          player falls back to Fast HLS. Prefer SRT/RTMP ingest when comparing browser delivery.
        </p>
        <p className="hint">
          Optional Broadcaster-side alternative (not auto-created here): error-concealed derived
          input with <code>continuous_timeline=1</code> in front of Fast HLS (~+100&nbsp;ms). Recipe:{" "}
          <a href="/api/debug/zixi-srt" target="_blank" rel="noreferrer">
            /api/debug/zixi-srt
          </a>
          . Config:{" "}
          <a
            href={`${GH_BLOB}/infra/zixi/scripts/configure-zixi-hls-dash-output.sh`}
            target="_blank"
            rel="noreferrer"
          >
            configure-zixi-hls-dash-output.sh
          </a>
          .
        </p>
      </section>

      <section className="about-section">
        <h3>Project goals</h3>
        <ul className="about-list">
          <li>
            Encode the <em>same</em> source (file or webcam) for every comparison leg under one
            wall-clock window.
          </li>
          <li>
            Publish over different ingest protocols (MoQ, SRT, RTMP, …) and observe transport,
            edge/relay, media integrity, playback, and optional VMAF side by side.
          </li>
          <li>
            Keep metrics comparable with a normalized model (`net_*`, media health, playback E2E)
            rather than protocol-specific charts only.
          </li>
          <li>
            Export raw CSV sample logs and summary JSON after each run — no historical archive in
            the UI.
          </li>
        </ul>
      </section>

      <section className="about-section">
        <h3>End-to-end architecture</h3>
        <p className="hint">
          Media path runs left → right: source and encode, then parallel ingest, then browser
          playback. Quality scoring runs on the ingest side.
        </p>
        <div className="about-arch">
          <ArchStage step="1" label="Source" tone="client">
            <FlowNode tone="client" title="Browser / camera" detail="file or webcam MediaRecorder" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="2" label="Encode (moq-web)" tone="server">
            <FlowNode
              tone="server"
              title="ffmpeg on moq-web VM"
              detail="H.264/AAC · GCP today · multi-cloud ready"
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
            <FlowNode tone="client" title="HLS Playback (Live)" detail="hls.js ← Zixi egress" />
            <FlowNode tone="client" title="MoQ Playback (Playa)" detail="WebTransport ← moqx" />
          </ArchStage>
        </div>
        <ul className="about-list">
          <li>
            <strong>Where ffmpeg runs:</strong> on the moq-web host (not in the browser). Webcam
            bytes arrive over WebSocket; VOD uses a local file on that VM.
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
        <div className="about-arch about-arch-compact">
          <ArchStage step="1" label="Capture" tone="client">
            <FlowNode tone="client" title="Media source" detail="dummy.mp4 or MediaRecorder" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="2" label="Jobs" tone="server">
            <FlowNode tone="server" title="Upload jobs" detail="SSE samples · Stop / cancel" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="3" label="Preview" tone="client">
            <FlowNode tone="client" title="MoQ Playback (Playa)" detail="WebTransport" />
            <FlowNode tone="client" title="HLS Playback (Live)" detail="hls.js · Zixi" />
          </ArchStage>
          <FlowArrow />
          <ArchStage step="4" label="Report" tone="client">
            <FlowNode tone="client" title="Session Details" detail="TTFF · stalls · E2E · downloads" />
          </ArchStage>
        </div>
        <ul className="about-list">
          <li>
            Webcam uses a live WebSocket bridge — not a pre-recorded upload — with a 5‑minute safety
            cap and user Stop.
          </li>
          <li>
            Browsers cannot play raw SRT/RTMP; traditional legs preview via Zixi HLS. MoQ requires a
            WebTransport-capable browser (Chrome / Edge).
          </li>
          <li>
            Estimated E2E latency is wall-clock since encode start minus player{" "}
            <code>currentTime</code>, including intentional HLS live buffer (default ~4s / 2×2s
            segments; may tighten to 1s).
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
