const GH_REPO = "https://github.com/BufferStarved/MoQ-Test-Tools";
const GH_BLOB = `${GH_REPO}/blob/main`;

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
  tone?: "default" | "client" | "transport" | "server";
}) {
  return (
    <div className={`about-flow-node tone-${tone}`}>
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function AboutPage() {
  return (
    <section className="panel about-panel">
      <header className="about-header">
        <div>
          <h2>About MoQ Test Tools</h2>
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
          Three GCP roles in us-central1 typically host the live demo: web UI/API, Zixi ingest, and
          the MoQ relay.
        </p>
        <div className="about-flow about-flow-wrap">
          <FlowNode tone="client" title="Browser" detail="React · players · webcam" />
          <FlowArrow />
          <FlowNode tone="server" title="moq-web API" detail="FastAPI · ffmpeg · jobs" />
          <FlowArrow />
          <div className="about-flow-branch">
            <FlowNode tone="transport" title="Zixi Broadcaster" detail="SRT / RTMP · HLS :7777" />
            <FlowNode tone="transport" title="moqx relay" detail="WebTransport · QUIC" />
          </div>
          <FlowArrow />
          <FlowNode tone="server" title="Ingest agent" detail="VMAF · CMAF · host metrics" />
        </div>
      </section>

      <section className="about-section">
        <h3>Client path</h3>
        <div className="about-flow about-flow-wrap">
          <FlowNode tone="client" title="Benchmark UI" detail="presets · Start / Stop" />
          <FlowArrow />
          <FlowNode tone="client" title="Media source" detail="dummy.mp4 or MediaRecorder" />
          <FlowArrow />
          <FlowNode tone="server" title="Upload jobs" detail="SSE samples · cancel" />
          <FlowArrow />
          <div className="about-flow-branch">
            <FlowNode tone="client" title="MoQ player" detail="moq-playa · WebTransport" />
            <FlowNode tone="client" title="HLS player" detail="hls.js · Zixi egress" />
          </div>
          <FlowArrow />
          <FlowNode tone="client" title="Playback metrics" detail="TTFF · stalls · E2E" />
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
            <code>currentTime</code>, including intentional HLS live buffer (~2 segments).
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
        <h3>Metric model (summary)</h3>
        <ol className="about-list numbered">
          <li>
            <strong>Encode</strong> — bitrate, FPS, speed, encode lag
          </li>
          <li>
            <strong>Network transport</strong> — normalized RTT / jitter / send / loss / retrans
          </li>
          <li>
            <strong>Edge & relay</strong> — Zixi/libsrt recovery; moqx subscribe & object counters
          </li>
          <li>
            <strong>Media health</strong> — TS continuity vs CMAF sequence / decode-time gaps
          </li>
          <li>
            <strong>Playback</strong> — TTFF, stalls, estimated glass-to-glass latency
          </li>
          <li>
            <strong>Video quality</strong> — encoder and ingest VMAF / PSNR / SSIM when enabled
          </li>
        </ol>
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
