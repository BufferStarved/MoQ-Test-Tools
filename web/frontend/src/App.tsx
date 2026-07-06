import { useEffect, useMemo, useState } from "react";
import {
  createUpload,
  fetchPresets,
  fetchProtocols,
  fetchResultDetail,
  fetchResults,
  subscribeToUpload,
} from "./api";
import type { Preset, Protocol, ResultSummary, UploadJob, UploadSample } from "./types";

type Tab = "benchmark" | "results" | "tools";

function App() {
  const [tab, setTab] = useState<Tab>("benchmark");
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [protocol, setProtocol] = useState("srt");
  const [endpointMode, setEndpointMode] = useState<"preset" | "custom">("preset");
  const [presetId, setPresetId] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [mediaPath, setMediaPath] = useState("dummy.mp4");
  const [duration, setDuration] = useState(30);
  const [activeJob, setActiveJob] = useState<UploadJob | null>(null);
  const [latestSample, setLatestSample] = useState<UploadSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultSummary | null>(null);
  const [resultFiles, setResultFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const protocolMeta = useMemo(
    () => protocols.find((item) => item.id === protocol),
    [protocols, protocol],
  );

  const filteredPresets = useMemo(
    () => presets.filter((preset) => preset.protocol === protocol),
    [presets, protocol],
  );

  useEffect(() => {
    fetchProtocols().then((data) => setProtocols(data.protocols));
    fetchPresets().then((data) => setPresets(data.presets));
    fetchResults().then((data) => setResultFiles(data.results.map((item) => item.filename)));
  }, []);

  useEffect(() => {
    fetchPresets(protocol).then((data) => {
      setPresets(data.presets);
      if (data.presets.length > 0) {
        setPresetId(data.presets[0].id);
      }
    });
  }, [protocol]);

  async function handleStart() {
    setError(null);
    setLatestSample(null);
    setLoading(true);

    try {
      const payload = {
        media_path: mediaPath,
        duration_sec: duration,
        ...(endpointMode === "preset"
          ? { preset_id: presetId }
          : { protocol, endpoint_url: endpointUrl }),
      };

      const job = await createUpload(payload);
      setActiveJob(job);

      subscribeToUpload(
        job.id,
        (sample) => setLatestSample(sample),
        (status) => {
          setActiveJob((current) =>
            current
              ? {
                  ...current,
                  status: status.status as UploadJob["status"],
                  csv_path: status.csv_path,
                  error: status.error,
                }
              : current,
          );

          if (status.status === "completed" || status.status === "failed") {
            setLoading(false);
            fetchResults().then((data) =>
              setResultFiles(data.results.map((item) => item.filename)),
            );
          }
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start upload");
      setLoading(false);
    }
  }

  async function loadResult(filename: string) {
    const detail = await fetchResultDetail(filename);
    setResults(detail);
    setTab("results");
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Streaming benchmark platform</p>
          <h1>MoQ Test Tools</h1>
          <p className="subtitle">
            Configure an ingest endpoint, run a live encode/upload benchmark, and export telemetry to CSV.
          </p>
        </div>
        <nav className="tabs">
          <button className={tab === "benchmark" ? "active" : ""} onClick={() => setTab("benchmark")}>
            Benchmark
          </button>
          <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>
            Results
          </button>
          <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>
            Tools
          </button>
        </nav>
      </header>

      <main>
        {tab === "benchmark" && (
          <section className="panel-grid">
            <div className="panel">
              <h2>Upload configuration</h2>

              <label>
                Protocol
                <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                  {protocols.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              {protocolMeta && (
                <p className="syntax">
                  <strong>Required syntax:</strong> {protocolMeta.syntax}
                </p>
              )}

              <div className="mode-toggle">
                <button
                  className={endpointMode === "preset" ? "active" : ""}
                  onClick={() => setEndpointMode("preset")}
                >
                  Preset endpoint
                </button>
                <button
                  className={endpointMode === "custom" ? "active" : ""}
                  onClick={() => setEndpointMode("custom")}
                >
                  Custom URL
                </button>
              </div>

              {endpointMode === "preset" ? (
                <label>
                  Preset
                  <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                    {filteredPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                        {preset.requires_env ? " (requires env)" : ""}
                      </option>
                    ))}
                  </select>
                  {filteredPresets.find((preset) => preset.id === presetId)?.notes && (
                    <span className="hint">
                      {filteredPresets.find((preset) => preset.id === presetId)?.notes}
                    </span>
                  )}
                </label>
              ) : (
                <label>
                  Endpoint URL
                  <input
                    type="url"
                    value={endpointUrl}
                    onChange={(e) => setEndpointUrl(e.target.value)}
                    placeholder={protocolMeta?.syntax}
                  />
                </label>
              )}

              <label>
                Media file path (on server)
                <input
                  type="text"
                  value={mediaPath}
                  onChange={(e) => setMediaPath(e.target.value)}
                />
              </label>

              <label>
                Duration (seconds)
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </label>

              {error && <p className="error">{error}</p>}

              <button className="primary" onClick={handleStart} disabled={loading}>
                {loading ? "Running benchmark..." : "Start upload benchmark"}
              </button>
            </div>

            <div className="panel status-panel">
              <h2>Live status</h2>
              {!activeJob && <p className="muted">Start a benchmark to see encode and upload telemetry.</p>}

              {activeJob && (
                <div className="status-card">
                  <div className="status-row">
                    <span>Job</span>
                    <code>{activeJob.id.slice(0, 8)}</code>
                  </div>
                  <div className="status-row">
                    <span>Status</span>
                    <strong className={`pill ${activeJob.status}`}>{activeJob.status}</strong>
                  </div>
                  <div className="status-row">
                    <span>Endpoint</span>
                    <code>{activeJob.endpoint_url}</code>
                  </div>
                </div>
              )}

              {latestSample && (
                <div className="metrics-grid">
                  <Metric label="Elapsed" value={`${latestSample.elapsed_sec}s`} />
                  <Metric label="Bitrate" value={`${latestSample.bitrate_kbps.toFixed(0)} kbps`} />
                  <Metric label="FPS" value={latestSample.fps.toFixed(1)} />
                  <Metric label="Speed" value={`${latestSample.speed.toFixed(2)}x`} />
                  <Metric label="CPU" value={`${latestSample.cpu_percent.toFixed(1)}%`} />
                  <Metric label="Memory" value={`${latestSample.memory_mb.toFixed(1)} MB`} />
                </div>
              )}

              {activeJob?.status === "completed" && activeJob.csv_path && (
                <div className="success-box">
                  Upload complete. Metrics saved to <code>{activeJob.csv_path}</code>
                </div>
              )}

              {activeJob?.status === "failed" && (
                <div className="error-box">{activeJob.error || "Upload failed"}</div>
              )}
            </div>
          </section>
        )}

        {tab === "results" && (
          <section className="panel">
            <h2>Results</h2>
            <div className="results-layout">
              <div>
                <h3>CSV files</h3>
                <ul className="file-list">
                  {resultFiles.map((filename) => (
                    <li key={filename}>
                      <button onClick={() => loadResult(filename)}>{filename}</button>
                    </li>
                  ))}
                  {resultFiles.length === 0 && <li className="muted">No results yet.</li>}
                </ul>
              </div>

              {results && (
                <div>
                  <h3>{results.filename}</h3>
                  <div className="metrics-grid">
                    <Metric label="Protocol" value={results.protocol} />
                    <Metric label="Samples" value={String(results.samples)} />
                    <Metric label="Avg bitrate" value={`${results.averages.bitrate_kbps} kbps`} />
                    <Metric label="Avg CPU" value={`${results.averages.cpu_percent}%`} />
                    <Metric label="Avg memory" value={`${results.averages.memory_mb} MB`} />
                    <Metric label="Avg speed" value={`${results.averages.speed}x`} />
                  </div>
                  <p className="hint endpoint-copy">{results.endpoint}</p>
                </div>
              )}
            </div>
          </section>
        )}

        {tab === "tools" && (
          <section className="panel">
            <h2>Additional tooling</h2>
            <p>
              This section is reserved for upcoming utilities: MoQ relay integration, batch comparisons,
              publisher automation, and deployment helpers.
            </p>
            <ul className="tool-list">
              <li>CLI runner: <code>python src/runner.py</code></li>
              <li>Publisher: <code>python src/publisher.py</code></li>
              <li>Preset list: <code>python src/runner.py --list-presets</code></li>
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
