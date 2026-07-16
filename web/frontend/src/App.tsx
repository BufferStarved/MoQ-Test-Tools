import { useCallback, useEffect, useState } from "react";
import {
  checkHealth,
  createUpload,
  fetchPresets,
  fetchProtocols,
  fetchResultDetail,
  fetchQualityAvailable,
  fetchResults,
  fetchUpload,
  fetchVmafAvailable,
  subscribeToUpload,
  uploadMedia,
} from "./api";
import { ComparisonCharts } from "./ComparisonCharts";
import { EndpointSection } from "./EndpointSection";
import { ResultsView } from "./ResultsView";
import { StreamPlayer } from "./StreamPlayer";
import { moqDefaultsFromPublishUrl } from "./playbackUrls";
import { playbackGateForJob } from "./playbackGate";
import { mergePlaybackSampleIntoUploadSample } from "./playbackMetricsShared";
import { groupResultFiles, type ResultSession } from "./resultGrouping";
import {
  INGEST_ENDPOINTS,
  ingestEndpointLabel,
  isCustomIngestEndpoint,
  presetIdForIngest,
  resolveEndpointUrl,
  type IngestEndpointId,
} from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol, ResultSummary, UploadJob, UploadSample } from "./types";

type Tab = "benchmark" | "results" | "tools";

const MIN_ENDPOINTS = 2;
const MAX_ENDPOINTS = 5;

interface ComparisonLegState {
  id: string;
  label: string;
  protocol: string;
  job: UploadJob;
  samples: UploadSample[];
  latestSample: UploadSample | null;
  ingestVmafRequested: boolean;
  encoderVmafRequested: boolean;
}

function createEndpointId(): string {
  return `ep-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildDefaultEndpoints(): EndpointConfig[] {
  return [
    {
      id: createEndpointId(),
      protocol: "srt",
      ingestEndpointId: "gcp_zixi",
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      playbackMode: "auto",
      playbackDvr: false,
    },
    {
      id: createEndpointId(),
      protocol: "rtmp",
      ingestEndpointId: "gcp_zixi",
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      playbackMode: "auto",
      playbackDvr: false,
    },
  ];
}

function endpointLabel(endpoint: EndpointConfig, index: number): string {
  if (!isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
    const ingest = ingestEndpointLabel(endpoint.ingestEndpointId);
    return `Stream ${index + 1} (${ingest} · ${endpoint.protocol.toUpperCase()})`;
  }
  if (endpoint.endpointUrl.trim()) {
    try {
      const host = new URL(endpoint.endpointUrl).hostname;
      return `Stream ${index + 1} (${host})`;
    } catch {
      return `Stream ${index + 1} (custom)`;
    }
  }
  return `Stream ${index + 1} (${endpoint.protocol})`;
}

function resolvePresetId(endpoint: EndpointConfig): string | undefined {
  if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
    return undefined;
  }
  return presetIdForIngest(endpoint.ingestEndpointId as IngestEndpointId, endpoint.protocol);
}

function isIngestEndpointAvailable(endpoint: EndpointConfig): boolean {
  if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
    return true;
  }
  return INGEST_ENDPOINTS.find((item) => item.id === endpoint.ingestEndpointId)?.available ?? false;
}

function isLegFinished(job: UploadJob, ingestVmafRequested: boolean): boolean {
  if (job.status === "failed") {
    return true;
  }
  if (job.status !== "completed") {
    return false;
  }
  if (!ingestVmafRequested) {
    return true;
  }
  return job.vmaf_status === "completed" || job.vmaf_status === "failed";
}

function App() {
  const [tab, setTab] = useState<Tab>("benchmark");
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [useDefaultMedia, setUseDefaultMedia] = useState(true);
  const [mediaPath, setMediaPath] = useState("dummy.mp4");
  const [mediaLabel, setMediaLabel] = useState("dummy.mp4");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [duration, setDuration] = useState(30);
  const [computeVmafOnIngest, setComputeVmafOnIngest] = useState(false);
  const [computeVmafEncoder, setComputeVmafEncoder] = useState(false);
  const [encoderVmafAvailable, setEncoderVmafAvailable] = useState(false);
  const [encoderVmafUnavailableReason, setEncoderVmafUnavailableReason] = useState<string | null>(null);
  const [vmafUnavailableReason, setVmafUnavailableReason] = useState<string | null>(null);
  const [comparisonLegs, setComparisonLegs] = useState<ComparisonLegState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resultStreams, setResultStreams] = useState<ResultSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [resultSessions, setResultSessions] = useState<ResultSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [apiOnline, setApiOnline] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const anyIngestVmafAvailable = endpoints.some((endpoint) => endpoint.vmafAvailable);
  const endpointSignature = endpoints
    .map(
      (endpoint) =>
        `${endpoint.id}:${endpoint.ingestEndpointId}:${endpoint.endpointUrl}:${endpoint.protocol}`,
    )
    .join("|");

  const loadBootstrapData = useCallback(async () => {
    setBootstrapping(true);
    setBootstrapError(null);

    try {
      await checkHealth();
      setApiOnline(true);

      const [protocolData, presetData, resultData] = await Promise.all([
        fetchProtocols(),
        fetchPresets(),
        fetchResults(),
      ]);

      setProtocols(protocolData.protocols);
      setPresets(presetData.presets);
      setResultSessions(groupResultFiles(resultData.results));
      setEndpoints((current) =>
        current.length >= MIN_ENDPOINTS ? current : buildDefaultEndpoints(),
      );
    } catch (err) {
      setApiOnline(false);
      setBootstrapError(err instanceof Error ? err.message : "Failed to load API data");
      setProtocols([]);
      setPresets([]);
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    void loadBootstrapData();
  }, [loadBootstrapData]);

  useEffect(() => {
    if (!apiOnline || presets.length === 0) {
      return;
    }

    setEndpoints((current) => {
      let changed = false;
      const next = current.map((endpoint) => {
        if (endpoint.protocol !== "moq" || endpoint.ingestEndpointId !== "gcp_moq_relay") {
          return endpoint;
        }
        const presetId = presetIdForIngest(endpoint.ingestEndpointId, endpoint.protocol);
        const publishUrl = presets.find((preset) => preset.id === presetId)?.url?.trim() ?? "";
        if (!publishUrl) {
          return endpoint;
        }
        const defaults = moqDefaultsFromPublishUrl(publishUrl);
        if (
          endpoint.moqRelayUrl === defaults.webTransportUrl &&
          endpoint.moqNamespace === defaults.namespace &&
          endpoint.moqFingerprintUrl === defaults.fingerprintUrl
        ) {
          return endpoint;
        }
        changed = true;
        return {
          ...endpoint,
          moqRelayUrl: defaults.webTransportUrl,
          moqNamespace: defaults.namespace,
          moqFingerprintUrl: defaults.fingerprintUrl,
        };
      });
      return changed ? next : current;
    });
  }, [apiOnline, presets]);

  useEffect(() => {
    if (!apiOnline || endpoints.length === 0) {
      return;
    }

    let cancelled = false;

    async function refreshCapabilities() {
      const updates = await Promise.all(
        endpoints.map(async (endpoint) => {
          const presetId = resolvePresetId(endpoint);
          const params = isCustomIngestEndpoint(endpoint.ingestEndpointId)
            ? { endpoint_url: endpoint.endpointUrl }
            : presetId
              ? { preset_id: presetId }
              : {};

          if (!isCustomIngestEndpoint(endpoint.ingestEndpointId) && (!presetId || !isIngestEndpointAvailable(endpoint))) {
            return { id: endpoint.id, vmafAvailable: false, serverMetricsAvailable: false };
          }
          if (isCustomIngestEndpoint(endpoint.ingestEndpointId) && !endpoint.endpointUrl.trim()) {
            return { id: endpoint.id, vmafAvailable: false, serverMetricsAvailable: false };
          }

          try {
            const result = await fetchVmafAvailable(params);
            const preset = presetId ? presets.find((item) => item.id === presetId) : undefined;
            const ingestAvailable =
              !isCustomIngestEndpoint(endpoint.ingestEndpointId) &&
              isIngestEndpointAvailable(endpoint) &&
              (preset?.supports_vmaf ?? false) &&
              result.available;
            const serverMetricsAvailable =
              !isCustomIngestEndpoint(endpoint.ingestEndpointId) && ingestAvailable;
            return {
              id: endpoint.id,
              vmafAvailable: ingestAvailable,
              serverMetricsAvailable,
            };
          } catch {
            return { id: endpoint.id, vmafAvailable: false, serverMetricsAvailable: false };
          }
        }),
      );

      if (cancelled) {
        return;
      }

      setEndpoints((current) =>
        current.map((endpoint) => {
          const update = updates.find((item) => item.id === endpoint.id);
          if (!update) {
            return endpoint;
          }
          return {
            ...endpoint,
            vmafAvailable: update.vmafAvailable,
            serverMetricsAvailable: update.serverMetricsAvailable,
          };
        }),
      );
    }

    void refreshCapabilities();

    return () => {
      cancelled = true;
    };
  }, [apiOnline, endpointSignature, presets]);

  useEffect(() => {
    if (!apiOnline) {
      setEncoderVmafAvailable(false);
      setEncoderVmafUnavailableReason(null);
      return;
    }

    let cancelled = false;
    void fetchQualityAvailable({})
      .then((result) => {
        if (cancelled) {
          return;
        }
        setEncoderVmafAvailable(result.encoder.available);
        setEncoderVmafUnavailableReason(result.encoder.available ? null : result.encoder.reason);
      })
      .catch(() => {
        if (!cancelled) {
          setEncoderVmafAvailable(false);
          setEncoderVmafUnavailableReason("Could not check encoder VMAF availability.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiOnline]);

  useEffect(() => {
    if (!anyIngestVmafAvailable) {
      setComputeVmafOnIngest(false);
      setVmafUnavailableReason("Ingest VMAF is not available for any selected managed endpoint.");
      return;
    }
    setVmafUnavailableReason("Runs on managed Zixi ingest endpoints after the upload completes.");
  }, [anyIngestVmafAvailable]);

  useEffect(() => {
    if (!encoderVmafAvailable) {
      setComputeVmafEncoder(false);
      return;
    }
  }, [encoderVmafAvailable]);

  function updateEndpoint(id: string, patch: Partial<EndpointConfig>) {
    setEndpoints((current) =>
      current.map((endpoint) => (endpoint.id === id ? { ...endpoint, ...patch } : endpoint)),
    );
  }

  function addEndpoint() {
    setEndpoints((current) => {
      if (current.length >= MAX_ENDPOINTS) {
        return current;
      }
      const protocol = protocols[0]?.id ?? "srt";
      return [
        ...current,
        {
          id: createEndpointId(),
          protocol,
          ingestEndpointId: "gcp_zixi",
          endpointUrl: "",
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: "auto",
          playbackDvr: false,
        },
      ];
    });
  }

  function removeEndpoint(id: string) {
    setEndpoints((current) => {
      if (current.length <= MIN_ENDPOINTS) {
        return current;
      }
      return current.filter((endpoint) => endpoint.id !== id);
    });
  }

  async function handleMediaUpload(file: File | null) {
    if (!file) {
      return;
    }
    setUploadingMedia(true);
    setError(null);
    try {
      const uploaded = await uploadMedia(file);
      setMediaPath(uploaded.media_path);
      setMediaLabel(uploaded.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Media upload failed");
    } finally {
      setUploadingMedia(false);
    }
  }

  function buildUploadPayload(
    endpoint: EndpointConfig,
    comparisonId: string,
    streamIndex: number,
  ): {
    media_path: string;
    duration_sec: number;
    compute_vmaf_on_ingest: boolean;
    compute_vmaf_encoder: boolean;
    comparison_id: string;
    stream_index: number;
    stream_label: string;
    preset_id?: string;
    protocol?: string;
    endpoint_url?: string;
  } {
    const presetId = resolvePresetId(endpoint);
    return {
      media_path: mediaPath,
      duration_sec: duration,
      compute_vmaf_on_ingest: computeVmafOnIngest && endpoint.vmafAvailable,
      compute_vmaf_encoder: computeVmafEncoder && encoderVmafAvailable,
      comparison_id: comparisonId,
      stream_index: streamIndex,
      stream_label: endpointLabel(endpoint, streamIndex),
      ...(isCustomIngestEndpoint(endpoint.ingestEndpointId)
        ? {
            protocol: endpoint.protocol,
            endpoint_url: endpoint.endpointUrl,
          }
        : { preset_id: presetId }),
    };
  }

  function subscribeLeg(
    job: UploadJob,
    ingestVmafRequested: boolean,
    onAllFinished?: () => void,
  ) {
    void fetchUpload(job.id)
      .then((fresh) => {
        setComparisonLegs((current) =>
          current.map((leg) =>
            leg.id === job.id
              ? {
                  ...leg,
                  job: fresh,
                }
              : leg,
          ),
        );
      })
      .catch(() => {
        // SSE will still drive status updates.
      });

    return subscribeToUpload(
      job.id,
      (sample) => {
        setComparisonLegs((current) =>
          current.map((leg) =>
            leg.id === job.id
              ? {
                  ...leg,
                  samples: [...leg.samples, sample],
                  latestSample: sample,
                }
              : leg,
          ),
        );
      },
      (status) => {
        const updatedJob: UploadJob = {
          ...job,
          status: status.status as UploadJob["status"],
          csv_path: status.csv_path,
          summary_path: status.summary_path,
          error: status.error,
          moq_namespace: status.moq_namespace ?? job.moq_namespace,
          vmaf_status: status.vmaf_status ?? job.vmaf_status,
          vmaf_score: status.vmaf_score ?? job.vmaf_score,
          vmaf_error: status.vmaf_error ?? job.vmaf_error,
          encoder_vmaf_status: status.encoder_vmaf_status ?? job.encoder_vmaf_status,
          encoder_vmaf_score: status.encoder_vmaf_score ?? job.encoder_vmaf_score,
          encoder_vmaf_error: status.encoder_vmaf_error ?? job.encoder_vmaf_error,
        };

        setComparisonLegs((current) => {
          const next = current.map((leg) =>
            leg.id === job.id
              ? {
                  ...leg,
                  job: updatedJob,
                  latestSample: leg.latestSample,
                }
              : leg,
          );
          if (next.every((leg) => isLegFinished(leg.job, leg.ingestVmafRequested))) {
            onAllFinished?.();
            void fetchResults().then((data) => {
              setResultSessions(groupResultFiles(data.results));
            });
          }
          return next;
        });
      },
    );
  }

  async function handleStart() {
    setError(null);
    setComparisonLegs([]);
    setLoading(true);

    const unavailableEndpoint = endpoints.find(
      (endpoint) =>
        !isCustomIngestEndpoint(endpoint.ingestEndpointId) &&
        (!isIngestEndpointAvailable(endpoint) || !resolvePresetId(endpoint)),
    );
    if (unavailableEndpoint) {
      setError("Select an available ingest endpoint (GCP Zixi) or use a custom URL.");
      setLoading(false);
      return;
    }

    const customWithoutUrl = endpoints.find(
      (endpoint) => isCustomIngestEndpoint(endpoint.ingestEndpointId) && !endpoint.endpointUrl.trim(),
    );
    if (customWithoutUrl) {
      setError("Enter an endpoint URL for streams using Custom URL.");
      setLoading(false);
      return;
    }

    if (!useDefaultMedia && mediaPath === "dummy.mp4") {
      setError("Upload source media or enable the default VOD asset.");
      setLoading(false);
      return;
    }

    try {
      const comparisonId = crypto.randomUUID();
      const jobs = await Promise.all(
        endpoints.map((endpoint, index) =>
          createUpload(buildUploadPayload(endpoint, comparisonId, index)),
        ),
      );

      const legs: ComparisonLegState[] = jobs.map((job, index) => ({
        id: job.id,
        label: endpointLabel(endpoints[index], index),
        protocol: job.protocol,
        job,
        samples: [],
        latestSample: null,
        ingestVmafRequested: computeVmafOnIngest && endpoints[index].vmafAvailable,
        encoderVmafRequested: computeVmafEncoder && encoderVmafAvailable,
      }));
      setComparisonLegs(legs);

      const finish = () => setLoading(false);
      jobs.forEach((job, index) => {
        subscribeLeg(job, legs[index].ingestVmafRequested, finish);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start upload");
      setLoading(false);
    }
  }

  async function loadResultSession(session: ResultSession) {
    const details = await Promise.all(session.files.map((filename) => fetchResultDetail(filename)));
    setResultStreams(details);
    setSelectedSessionId(session.id);
    setTab("results");
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Streaming benchmark platform</p>
          <h1>MoQ Test Tools</h1>
          <p className="subtitle">
            Compare two or more streams side by side using the same source media and live-stream duration.
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

      {bootstrapError && (
        <div className="error-box api-banner">
          <strong>API unavailable.</strong> {bootstrapError}
          <button className="retry-button" onClick={() => void loadBootstrapData()}>
            Retry connection
          </button>
        </div>
      )}

      <main>
        {tab === "benchmark" && (
          <section className="panel-grid">
            <div className="panel">
              <h2>Upload configuration</h2>
              <p className="hint">
                Each stream uses the same source media and duration so metrics align in time. The
                player beside each stream uses the selected playback mode — start a benchmark so
                live outputs are available.
              </p>

              {endpoints.map((endpoint, index) => (
                <div key={endpoint.id} className="stream-config-row">
                  <EndpointSection
                    index={index}
                    endpoint={endpoint}
                    protocols={protocols}
                    presets={presets}
                    bootstrapping={bootstrapping}
                    apiOnline={apiOnline}
                    canRemove={endpoints.length > MIN_ENDPOINTS}
                    onChange={updateEndpoint}
                    onRemove={removeEndpoint}
                  />
                  <div className="stream-player-column">
                    <StreamPlayer
                      key={`${endpoint.id}:${endpoint.playbackMode ?? "auto"}:${endpoint.protocol}:${endpoint.ingestEndpointId}`}
                      title={`Stream ${index + 1} preview`}
                      protocol={endpoint.protocol}
                      endpointUrl={resolveEndpointUrl(endpoint, presets)}
                      ingestEndpointId={endpoint.ingestEndpointId}
                      playbackMode={endpoint.playbackMode}
                      playbackDvr={endpoint.playbackDvr}
                      whepPlaybackUrl={endpoint.whepPlaybackUrl}
                      moqRelayUrl={endpoint.moqRelayUrl}
                      moqFingerprintUrl={endpoint.moqFingerprintUrl}
                      moqNamespace={
                        comparisonLegs[index]?.job.moq_namespace ??
                        endpoint.moqNamespace
                      }
                      playbackGate={playbackGateForJob(comparisonLegs[index]?.job, loading)}
                      jobId={comparisonLegs[index]?.job.id}
                      encodeStartedAtEpoch={comparisonLegs[index]?.job.started_at_epoch}
                      onPlaybackSample={(playback) => {
                        const jobId = comparisonLegs[index]?.job.id;
                        if (!jobId) {
                          return;
                        }
                        setComparisonLegs((current) =>
                          current.map((leg) =>
                            leg.id === jobId
                              ? {
                                  ...leg,
                                  samples: mergePlaybackSampleIntoUploadSample(leg.samples, playback),
                                }
                              : leg,
                          ),
                        );
                      }}
                      jobStatus={comparisonLegs[index]?.job.status}
                      benchmarkLoading={loading}
                      encodeDurationSec={duration}
                    />
                  </div>
                </div>
              ))}

              {endpoints.length < MAX_ENDPOINTS && (
                <button type="button" className="ghost-button add-output-button" onClick={addEndpoint}>
                  Add another stream ({endpoints.length}/{MAX_ENDPOINTS})
                </button>
              )}

              <div className="source-media-section">
                <h3>Media</h3>
                <p className="hint">
                  Upload a VOD asset which will be encoded into a live stream or use the default VOD asset.
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={useDefaultMedia}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUseDefaultMedia(checked);
                      if (checked) {
                        setMediaPath("dummy.mp4");
                        setMediaLabel("dummy.mp4");
                      }
                    }}
                  />
                  <span>Use default (dummy.mp4)</span>
                </label>
                {!useDefaultMedia && (
                  <label>
                    Source media
                    <input
                      type="file"
                      accept="video/*,.mp4,.mov,.mkv,.ts"
                      disabled={uploadingMedia}
                      onChange={(e) => void handleMediaUpload(e.target.files?.[0] ?? null)}
                    />
                    <span className="hint">
                      {uploadingMedia
                        ? "Uploading..."
                        : `Using: ${mediaLabel} (${mediaPath})`}
                    </span>
                  </label>
                )}
              </div>

              <label>
                Duration (seconds) of live stream
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </label>

              <div className="vmaf-section">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={computeVmafEncoder}
                    disabled={!encoderVmafAvailable}
                    onChange={(e) => setComputeVmafEncoder(e.target.checked)}
                  />
                  <span>Encoder VMAF (local) — VMAF, PSNR, SSIM on captured output</span>
                </label>
                <p className="hint">
                  {encoderVmafAvailable
                    ? "Scores the ffmpeg output before it leaves this machine. Works for all protocols."
                    : encoderVmafUnavailableReason ?? "Encoder VMAF requires ffmpeg with libvmaf locally."}
                </p>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={computeVmafOnIngest}
                    disabled={!anyIngestVmafAvailable}
                    onChange={(e) => setComputeVmafOnIngest(e.target.checked)}
                  />
                  <span>Ingest VMAF (server) — VMAF, PSNR, SSIM after ingest recording</span>
                </label>
                <p className="hint">
                  {anyIngestVmafAvailable
                    ? vmafUnavailableReason
                    : vmafUnavailableReason ?? "Ingest VMAF is only available for managed Zixi endpoints."}
                </p>
              </div>

              {error && <p className="error">{error}</p>}

              <button
                className="primary"
                onClick={() => void handleStart()}
                disabled={loading || bootstrapping || !apiOnline || endpoints.length < MIN_ENDPOINTS}
              >
                {loading ? "Running comparison..." : `Start comparison (${endpoints.length} streams)`}
              </button>
            </div>

            <div className="panel status-panel">
              <h2>Comparison status</h2>
              {comparisonLegs.length === 0 && (
                <p className="muted">Start a comparison to see all uploads side by side.</p>
              )}

              {comparisonLegs.length > 0 && (
                <div className="comparison-status-grid">
                  {comparisonLegs.map((leg) => (
                    <div key={leg.id} className="status-card">
                      <div className="status-row">
                        <span>{leg.label}</span>
                        <strong className={`pill ${leg.job.status}`}>{leg.job.status}</strong>
                      </div>
                      <div className="status-row">
                        <span>Job</span>
                        <code>{leg.job.id.slice(0, 8)}</code>
                      </div>
                      {leg.encoderVmafRequested && (
                        <div className="status-row">
                          <span>Encoder quality</span>
                          <strong className={`pill ${leg.job.encoder_vmaf_status ?? "disabled"}`}>
                            {formatVmafStatus(leg.job.encoder_vmaf_status)}
                            {leg.job.encoder_vmaf_score != null ? ` (VMAF ${leg.job.encoder_vmaf_score})` : ""}
                          </strong>
                        </div>
                      )}
                      {leg.ingestVmafRequested && (
                        <div className="status-row">
                          <span>Ingest quality</span>
                          <strong className={`pill ${leg.job.vmaf_status ?? "disabled"}`}>
                            {formatVmafStatus(leg.job.vmaf_status)}
                            {leg.job.vmaf_score != null ? ` (VMAF ${leg.job.vmaf_score})` : ""}
                          </strong>
                        </div>
                      )}
                      <div className="status-row">
                        <span>Endpoint</span>
                        <code>{leg.job.endpoint_url}</code>
                      </div>
                      {leg.latestSample && (
                        <div className="metrics-grid comparison-metrics">
                          <Metric label="Bitrate" value={`${leg.latestSample.encoded_bitrate_kbps.toFixed(0)} kbps`} />
                          <Metric
                            label="Send rate"
                            value={
                              leg.latestSample.encoder_send_rate_mbps
                                ? `${leg.latestSample.encoder_send_rate_mbps.toFixed(2)} Mbps`
                                : "—"
                            }
                          />
                          <Metric
                            label="RTT"
                            value={
                              leg.latestSample.transport_rtt_ms
                                ? `${leg.latestSample.transport_rtt_ms.toFixed(1)} ms`
                                : "—"
                            }
                          />
                          <Metric label="FPS" value={leg.latestSample.fps.toFixed(1)} />
                          <Metric
                            label="Client mem"
                            value={
                              leg.latestSample.client_memory_percent
                                ? `${leg.latestSample.client_memory_percent.toFixed(1)}%`
                                : "—"
                            }
                          />
                          {(leg.latestSample.server_cpu_percent ?? 0) > 0 && (
                            <Metric
                              label="Server CPU"
                              value={`${leg.latestSample.server_cpu_percent?.toFixed(1)}%`}
                            />
                          )}
                        </div>
                      )}
                      {leg.job.encoder_vmaf_error && <p className="error">{leg.job.encoder_vmaf_error}</p>}
                      {leg.job.vmaf_error && <p className="error">{leg.job.vmaf_error}</p>}
                    </div>
                  ))}
                </div>
              )}

              {(loading || comparisonLegs.some((leg) => leg.samples.length > 0)) && (
                <div className="live-charts">
                  <h3>Comparison charts</h3>
                  <ComparisonCharts
                    legs={comparisonLegs.map((leg) => ({
                      id: leg.id,
                      label: leg.label,
                      protocol: leg.protocol,
                      samples: leg.samples,
                      vmafScore: leg.job.vmaf_score,
                    }))}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {tab === "results" && (
          <section className="panel results-panel">
            <h2>Results</h2>
            <div className="results-layout">
              <aside className="results-sidebar">
                <h3>Saved runs</h3>
                <ul className="file-list">
                  {resultSessions.map((session) => (
                    <li key={session.id}>
                      <button
                        className={selectedSessionId === session.id ? "active" : ""}
                        onClick={() => void loadResultSession(session)}
                      >
                        {session.label}
                      </button>
                    </li>
                  ))}
                  {resultSessions.length === 0 && <li className="muted">No results yet.</li>}
                </ul>
              </aside>

              <div className="results-detail">
                {resultStreams.length === 0 ? (
                  <p className="muted">Select a saved run to view per-stream summaries and comparison charts.</p>
                ) : (
                  <ResultsView streams={resultStreams} />
                )}
              </div>
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

function formatVmafStatus(status?: string | null): string {
  if (!status || status === "disabled") {
    return "disabled";
  }
  return status.replaceAll("_", " ");
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
