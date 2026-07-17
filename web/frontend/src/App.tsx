import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkHealth,
  createLiveSession,
  createUpload,
  fetchPresets,
  fetchProtocols,
  fetchResultDetail,
  fetchQualityAvailable,
  fetchUpload,
  fetchVmafAvailable,
  resultDownloadUrl,
  resultFilenameFromPath,
  stopUpload,
  subscribeToUpload,
} from "./api";
import { MetricLabel } from "./MetricLabel";
import { ComparisonCharts } from "./ComparisonCharts";
import { EndpointSection } from "./EndpointSection";
import { AboutPage } from "./AboutPage";
import { SessionMetrics } from "./SessionMetrics";
import { StreamPlayer } from "./StreamPlayer";
import { moqDefaultsFromPublishUrl } from "./playbackUrls";
import { playbackGateForJob } from "./playbackGate";
import { mergePlaybackSampleIntoUploadSample } from "./playbackMetricsShared";
import {
  INGEST_ENDPOINTS,
  ingestEndpointLabel,
  isCustomIngestEndpoint,
  presetIdForIngest,
  resolveEndpointUrl,
  type IngestEndpointId,
} from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol, ResultSummary, UploadJob, UploadSample } from "./types";
import {
  LIVE_WEBCAM_MAX_DURATION_SEC,
  openWebcamStream,
  startLiveWebcamBroadcast,
  webcamCaptureSeconds,
} from "./webcamCapture";
import {
  DEFAULT_ENCODE_LADDER_ID,
  DEFAULT_TARGET_LATENCY_MS,
  ENCODE_LADDER_OPTIONS,
  MAX_TARGET_LATENCY_MS,
  MIN_TARGET_LATENCY_MS,
  clampTargetLatencyMs,
  hlsLiveSyncCount,
  hlsLiveSyncDurationSec,
  moqPlayerTargetLatencyMs,
} from "./encodeProfiles";
import { isSafariBrowser } from "./browserDetect";

type MediaSourceId = "dummy" | "bbb" | "webcam";

type Tab = "benchmark" | "metrics" | "about";

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
  const [mediaSource, setMediaSource] = useState<MediaSourceId>("dummy");
  const [, setMediaPath] = useState("dummy.mp4");
  const [mediaLabel, setMediaLabel] = useState("Default Color Bar Asset (dummy.mp4)");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [computeVmaf, setComputeVmaf] = useState(false);
  const [encodeLadder, setEncodeLadder] = useState(DEFAULT_ENCODE_LADDER_ID);
  const [targetLatencyMs, setTargetLatencyMs] = useState(DEFAULT_TARGET_LATENCY_MS);
  const [encoderVmafAvailable, setEncoderVmafAvailable] = useState(false);
  const [encoderVmafUnavailableReason, setEncoderVmafUnavailableReason] = useState<string | null>(null);
  const [vmafUnavailableReason, setVmafUnavailableReason] = useState<string | null>(null);
  const [comparisonLegs, setComparisonLegs] = useState<ComparisonLegState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionMetrics, setSessionMetrics] = useState<ResultSummary[]>([]);
  const [sessionMetricLabels, setSessionMetricLabels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [apiOnline, setApiOnline] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [webcamStatus, setWebcamStatus] = useState<string | null>(null);
  const webcamPreviewRef = useRef<HTMLVideoElement | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const liveBroadcastRef = useRef<ReturnType<typeof startLiveWebcamBroadcast> | null>(null);

  const anyIngestVmafAvailable = endpoints.some((endpoint) => endpoint.vmafAvailable);
  /** Enable checkbox when we can score at least one leg (encoder and/or ingest). */
  const vmafSelectable = encoderVmafAvailable || anyIngestVmafAvailable;
  const vmafBothAvailable = encoderVmafAvailable && anyIngestVmafAvailable;
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

      const [protocolData, presetData] = await Promise.all([fetchProtocols(), fetchPresets()]);

      setProtocols(protocolData.protocols);
      setPresets(presetData.presets);
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
    if (!vmafSelectable) {
      // Only clear the checkbox when nothing can score — do not clear during
      // brief capability-refresh flicker if the user already opted in.
      setComputeVmaf(false);
      setVmafUnavailableReason(
        encoderVmafUnavailableReason ??
          "VMAF needs ffmpeg/libvmaf on this host and/or an ingest server with recording support.",
      );
      return;
    }
    if (mediaSource === "webcam") {
      setVmafUnavailableReason(
        "VMAF / PSNR / SSIM need a file reference — disabled for live webcam. Use the color-bar asset to score quality.",
      );
      return;
    }
    if (!vmafBothAvailable) {
      setVmafUnavailableReason(
        encoderVmafAvailable
          ? "Ingest VMAF is unavailable for some endpoints — encoder scores will still run where possible."
          : "Encoder libvmaf is unavailable — ingest scores will still run where possible.",
      );
      return;
    }
    setVmafUnavailableReason(null);
  }, [
    vmafSelectable,
    vmafBothAvailable,
    encoderVmafAvailable,
    anyIngestVmafAvailable,
    encoderVmafUnavailableReason,
    mediaSource,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function syncWebcamPreview() {
      const existing = webcamStreamRef.current;
      if (existing) {
        existing.getTracks().forEach((track) => track.stop());
        webcamStreamRef.current = null;
      }
      if (webcamPreviewRef.current) {
        webcamPreviewRef.current.srcObject = null;
      }
      if (mediaSource !== "webcam") {
        setWebcamStatus(null);
        return;
      }
      setWebcamStatus("Requesting webcam…");
      try {
        const stream = await openWebcamStream();
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        webcamStreamRef.current = stream;
        if (webcamPreviewRef.current) {
          webcamPreviewRef.current.srcObject = stream;
          void webcamPreviewRef.current.play().catch(() => undefined);
        }
        setWebcamStatus("Webcam ready — capture starts when you run the comparison.");
      } catch (err) {
        setWebcamStatus(err instanceof Error ? err.message : "Could not open webcam.");
      }
    }

    void syncWebcamPreview();
    return () => {
      cancelled = true;
      const stream = webcamStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        webcamStreamRef.current = null;
      }
    };
  }, [mediaSource]);

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

  function buildUploadPayload(
    endpoint: EndpointConfig,
    comparisonId: string,
    streamIndex: number,
    resolvedMediaPath: string,
    durationSec?: number,
  ): {
    media_path: string;
    duration_sec?: number;
    compute_vmaf_on_ingest: boolean;
    compute_vmaf_encoder: boolean;
    encode_ladder: string;
    target_latency_ms: number;
    comparison_id: string;
    stream_index: number;
    stream_label: string;
    preset_id?: string;
    protocol?: string;
    endpoint_url?: string;
  } {
    const presetId = resolvePresetId(endpoint);
    const isLive = resolvedMediaPath.toLowerCase().startsWith("udp://");
    return {
      media_path: resolvedMediaPath,
      ...(durationSec != null ? { duration_sec: durationSec } : {}),
      // Live webcam has no file reference for VMAF.
      compute_vmaf_on_ingest: computeVmaf && endpoint.vmafAvailable && !isLive,
      compute_vmaf_encoder: computeVmaf && encoderVmafAvailable && !isLive,
      encode_ladder: encodeLadder,
      target_latency_ms: clampTargetLatencyMs(targetLatencyMs),
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
    _ingestVmafRequested: boolean,
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
        setComparisonLegs((current) => {
          const next = current.map((leg) => {
            if (leg.id !== job.id) {
              return leg;
            }
            const updatedJob: UploadJob = {
              ...leg.job,
              status: status.status as UploadJob["status"],
              csv_path: status.csv_path ?? leg.job.csv_path,
              summary_path: status.summary_path ?? leg.job.summary_path,
              error: status.error,
              moq_namespace: status.moq_namespace ?? leg.job.moq_namespace,
              vmaf_status: status.vmaf_status ?? leg.job.vmaf_status,
              vmaf_score: status.vmaf_score ?? leg.job.vmaf_score,
              psnr_db: status.psnr_db ?? leg.job.psnr_db,
              ssim: status.ssim ?? leg.job.ssim,
              vmaf_error: status.vmaf_error ?? leg.job.vmaf_error,
              encoder_vmaf_status: status.encoder_vmaf_status ?? leg.job.encoder_vmaf_status,
              encoder_vmaf_score: status.encoder_vmaf_score ?? leg.job.encoder_vmaf_score,
              encoder_psnr_db: status.encoder_psnr_db ?? leg.job.encoder_psnr_db,
              encoder_ssim: status.encoder_ssim ?? leg.job.encoder_ssim,
              encoder_vmaf_error: status.encoder_vmaf_error ?? leg.job.encoder_vmaf_error,
            };
            return {
              ...leg,
              job: updatedJob,
              latestSample: leg.latestSample,
            };
          });
          if (next.every((leg) => isLegFinished(leg.job, leg.ingestVmafRequested))) {
            onAllFinished?.();
            void loadSessionMetricsFromLegs(next);
          }
          return next;
        });
      },
    );
  }

  async function loadSessionMetricsFromLegs(legs: ComparisonLegState[]) {
    const entries = legs
      .map((leg) => ({
        label: leg.label,
        filename: resultFilenameFromPath(leg.job.csv_path),
      }))
      .filter((entry): entry is { label: string; filename: string } => Boolean(entry.filename));

    if (entries.length === 0) {
      return;
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const details = await Promise.all(entries.map((entry) => fetchResultDetail(entry.filename)));
        setSessionMetrics(details);
        setSessionMetricLabels(entries.map((entry) => entry.label));
        setTab("metrics");
        return;
      } catch {
        await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
  }

  async function handleStart() {
    setError(null);
    setComparisonLegs([]);
    setSessionMetrics([]);
    setSessionMetricLabels([]);
    setLoading(true);

    const unavailableEndpoint = endpoints.find(
      (endpoint) =>
        !isCustomIngestEndpoint(endpoint.ingestEndpointId) &&
        (!isIngestEndpointAvailable(endpoint) || !resolvePresetId(endpoint)),
    );
    if (unavailableEndpoint) {
      setError("Select an available ingest endpoint (Zixi Broadcaster gcp-us-central1) or use a custom URL.");
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

    try {
      if (mediaSource === "bbb") {
        throw new Error("Big Buck Bunny is not available yet.");
      }

      const comparisonId = crypto.randomUUID();
      let mediaPaths: string[];
      let durationSec: number | undefined;
      liveBroadcastRef.current = null;

      if (mediaSource === "webcam") {
        setUploadingMedia(true);
        setWebcamStatus("Starting live webcam session…");
        const live = await createLiveSession({
          stream_count: endpoints.length,
          duration_sec: LIVE_WEBCAM_MAX_DURATION_SEC,
        });
        durationSec = live.duration_sec;
        mediaPaths = live.media_paths;

        let stream = webcamStreamRef.current;
        if (!stream || stream.getTracks().every((track) => track.readyState === "ended")) {
          stream = await openWebcamStream();
          webcamStreamRef.current = stream;
          if (webcamPreviewRef.current) {
            webcamPreviewRef.current.srcObject = stream;
          }
        }

        const liveBroadcast = startLiveWebcamBroadcast({
          stream,
          wsPath: live.ws_path,
          maxDurationSec: live.duration_sec,
          onStatus: setWebcamStatus,
        });
        liveBroadcastRef.current = liveBroadcast;
        await liveBroadcast.ready;
        setUploadingMedia(false);
        setWebcamStatus(
          `Live camera streaming — press Stop when finished (auto-stops at ${LIVE_WEBCAM_MAX_DURATION_SEC / 60} min).`,
        );
      } else {
        mediaPaths = endpoints.map(() => "dummy.mp4");
        setMediaPath("dummy.mp4");
      }

      const jobs = await Promise.all(
        endpoints.map((endpoint, index) =>
          createUpload(
            buildUploadPayload(
              endpoint,
              comparisonId,
              index,
              mediaPaths[index] ?? mediaPaths[0],
              durationSec,
            ),
          ),
        ),
      );

      const legs: ComparisonLegState[] = jobs.map((job, index) => ({
        id: job.id,
        label: endpointLabel(endpoints[index], index),
        protocol: job.protocol,
        job,
        samples: [],
        latestSample: null,
        ingestVmafRequested:
          computeVmaf && endpoints[index].vmafAvailable && mediaSource !== "webcam",
        encoderVmafRequested: computeVmaf && encoderVmafAvailable && mediaSource !== "webcam",
      }));
      setComparisonLegs(legs);

      const finish = () => {
        liveBroadcastRef.current?.stop();
        liveBroadcastRef.current = null;
        setLoading(false);
        if (mediaSource === "webcam") {
          setWebcamStatus("Live webcam run finished.");
        }
      };
      jobs.forEach((job, index) => {
        subscribeLeg(job, legs[index].ingestVmafRequested, finish);
      });
      void liveBroadcastRef.current?.finished.then(() => {
        setWebcamStatus((current) => current ?? "Live webcam send complete.");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start upload");
      setLoading(false);
      setUploadingMedia(false);
      liveBroadcastRef.current?.stop();
      liveBroadcastRef.current = null;
    }
  }

  async function handleStopWebcam() {
    setWebcamStatus("Stopping live webcam and encoders…");
    liveBroadcastRef.current?.stop();
    liveBroadcastRef.current = null;
    const stream = webcamStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      webcamStreamRef.current = null;
      if (webcamPreviewRef.current) {
        webcamPreviewRef.current.srcObject = null;
      }
    }
    await Promise.all(
      comparisonLegs.map((leg) =>
        stopUpload(leg.id).catch(() => ({ ok: false, status: "error" })),
      ),
    );
  }

  const safariUnsupported = isSafariBrowser();

  return (
    <div className="app">
      {safariUnsupported && (
        <div className="info-banner safari-banner" role="status">
          <strong>Safari playback is not currently supported.</strong> Upload benchmarking
          will still function. For MoQ and live preview players, use Chrome or Edge.
        </div>
      )}
      <header className="hero">
        <div>
          <p className="eyebrow">Streaming benchmark platform</p>
          <h1>MoQ Test Tools</h1>
          <p className="subtitle">
            Compare two or more live ingest protocols side by side.
          </p>
        </div>
        <nav className="tabs">
          <button className={tab === "benchmark" ? "active" : ""} onClick={() => setTab("benchmark")}>
            Benchmark
          </button>
          <button className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
            Session Details{sessionMetrics.length > 0 ? ` (${sessionMetrics.length})` : ""}
          </button>
          <button className={tab === "about" ? "active" : ""} onClick={() => setTab("about")}>
            About
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
                Configure each stream side by side. Shared media and quality options sit below.
                Choose the playback player under each Preview.
              </p>

              <div className="endpoints-grid">
                {endpoints.map((endpoint, index) => (
                  <EndpointSection
                    key={endpoint.id}
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
                ))}
              </div>

              {endpoints.length < MAX_ENDPOINTS && (
                <button type="button" className="ghost-button add-output-button" onClick={addEndpoint}>
                  Add another stream ({endpoints.length}/{MAX_ENDPOINTS})
                </button>
              )}

              <div className="source-media-section">
                <h3>Encode profile</h3>
                <div className="encode-profile-grid">
                  <label>
                    Target bitrate / resolution
                    <select
                      value={encodeLadder}
                      onChange={(e) => setEncodeLadder(e.target.value)}
                      disabled={bootstrapping || !apiOnline || loading}
                    >
                      {ENCODE_LADDER_OPTIONS.map((ladder) => (
                        <option key={ladder.id} value={ladder.id}>
                          {ladder.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Target latency (ms)
                    <input
                      type="number"
                      min={MIN_TARGET_LATENCY_MS}
                      max={MAX_TARGET_LATENCY_MS}
                      step={50}
                      value={targetLatencyMs}
                      disabled={bootstrapping || !apiOnline || loading}
                      onChange={(e) =>
                        setTargetLatencyMs(clampTargetLatencyMs(Number(e.target.value)))
                      }
                    />
                  </label>
                </div>
                <p className="hint">
                  Latency ({MIN_TARGET_LATENCY_MS}–{MAX_TARGET_LATENCY_MS} ms) scales encoder GOP /
                  VBV, SRT/Zixi latency, MoQ player catch-up, and HLS live buffer (default 2×2s
                  segments = 4s, down to 1s). Bitrate sets
                  H.264 scale + target/maxrate for every comparison leg.
                </p>
              </div>

              <div className="source-media-section">
                <h3>Media</h3>
                <label>
                  Source
                  <select
                    value={mediaSource}
                    onChange={(e) => {
                      const next = e.target.value as MediaSourceId;
                      setMediaSource(next);
                      if (next === "dummy") {
                        setMediaPath("dummy.mp4");
                        setMediaLabel("Default Color Bar Asset (dummy.mp4)");
                      } else if (next === "bbb") {
                        setMediaLabel("Big Buck Bunny (coming soon)");
                      } else {
                        setMediaLabel("Webcam");
                      }
                    }}
                  >
                    <option value="dummy">Default Color Bar Asset (dummy.mp4)</option>
                    <option value="bbb" disabled>
                      Big Buck Bunny (coming soon)
                    </option>
                    <option value="webcam">Webcam</option>
                  </select>
                </label>
                {mediaSource === "dummy" && (
                  <p className="hint">
                    Uses the built-in color-bar asset. Encode length matches the file duration
                    (about 60s).
                  </p>
                )}
                {mediaSource === "webcam" && (
                  <div className="webcam-preview-block">
                    <video
                      ref={webcamPreviewRef}
                      className="webcam-preview"
                      muted
                      playsInline
                      autoPlay
                    />
                    <p className="hint">
                      {webcamStatus ??
                        `Live camera → ffmpeg → Zixi/MoQ. Press Stop when finished. Auto-stops after ${webcamCaptureSeconds() / 60} minutes for safety. Preview players show the live encode (not a pre-recorded file). VMAF is disabled for live webcam.`}
                    </p>
                  </div>
                )}
                {mediaSource !== "webcam" && mediaSource !== "dummy" && (
                  <p className="hint">Using: {mediaLabel}</p>
                )}
              </div>

              <div className="vmaf-section">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={computeVmaf && mediaSource !== "webcam"}
                    disabled={!vmafSelectable || mediaSource === "webcam"}
                    onChange={(e) => setComputeVmaf(e.target.checked)}
                  />
                  <span>Compute VMAF — encoder + ingest (VMAF, PSNR, SSIM)</span>
                </label>
                <p className="hint">
                  Encoder: scores the ffmpeg output before it leaves this host.
                  <br />
                  Ingest: scores the recording after upload. Runs on the ingest server.
                  Requires the color-bar (or uploaded) file — not live webcam.
                </p>
                {vmafUnavailableReason && <p className="hint">{vmafUnavailableReason}</p>}
              </div>

              {error && <p className="error">{error}</p>}

              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => void handleStart()}
                  disabled={
                    loading ||
                    bootstrapping ||
                    !apiOnline ||
                    endpoints.length < MIN_ENDPOINTS ||
                    uploadingMedia ||
                    mediaSource === "bbb"
                  }
                >
                  {uploadingMedia
                    ? "Preparing media..."
                    : loading
                      ? "Running comparison..."
                      : `Start comparison (${endpoints.length} streams)`}
                </button>
                {loading && mediaSource === "webcam" && (
                  <button className="secondary-button stop-webcam-button" onClick={() => void handleStopWebcam()}>
                    Stop webcam
                  </button>
                )}
              </div>

              <div className="player-grid benchmark-players">
                {endpoints.map((endpoint, index) => (
                  <StreamPlayer
                    key={`${endpoint.id}:${endpoint.playbackMode ?? "auto"}:${endpoint.protocol}:${endpoint.ingestEndpointId}`}
                    title={`Stream ${index + 1} Preview`}
                    protocol={endpoint.protocol}
                    endpointUrl={resolveEndpointUrl(endpoint, presets)}
                    ingestEndpointId={endpoint.ingestEndpointId}
                    playbackMode={endpoint.playbackMode}
                    playbackDvr={false}
                    whepPlaybackUrl={endpoint.whepPlaybackUrl}
                    moqRelayUrl={endpoint.moqRelayUrl}
                    moqFingerprintUrl={endpoint.moqFingerprintUrl}
                    moqNamespace={
                      comparisonLegs[index]?.job.moq_namespace ??
                      (comparisonLegs[index] ? undefined : endpoint.moqNamespace)
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
                    encodeDurationSec={comparisonLegs[index]?.job.duration_sec ?? 60}
                    targetLatencyMs={moqPlayerTargetLatencyMs(
                      comparisonLegs[index]?.job.target_latency_ms ?? targetLatencyMs,
                    )}
                    hlsLiveSyncCount={hlsLiveSyncCount(
                      comparisonLegs[index]?.job.target_latency_ms ?? targetLatencyMs,
                    )}
                    hlsLiveSyncDurationSec={hlsLiveSyncDurationSec(
                      comparisonLegs[index]?.job.target_latency_ms ?? targetLatencyMs,
                    )}
                    controlsLocked={bootstrapping || !apiOnline}
                    onPlaybackModeChange={(mode) =>
                      updateEndpoint(endpoint.id, { playbackMode: mode })
                    }
                    onWhepPlaybackUrlChange={(url) =>
                      updateEndpoint(endpoint.id, { whepPlaybackUrl: url })
                    }
                  />
                ))}
              </div>
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
                            {formatQualityScores(
                              leg.job.encoder_vmaf_score,
                              leg.job.encoder_psnr_db,
                              leg.job.encoder_ssim,
                            )}
                          </strong>
                        </div>
                      )}
                      {leg.ingestVmafRequested && (
                        <div className="status-row">
                          <span>Ingest quality</span>
                          <strong className={`pill ${leg.job.vmaf_status ?? "disabled"}`}>
                            {formatVmafStatus(leg.job.vmaf_status)}
                            {formatQualityScores(leg.job.vmaf_score, leg.job.psnr_db, leg.job.ssim)}
                          </strong>
                        </div>
                      )}
                      <div className="status-row">
                        <span>Endpoint</span>
                        <code>{leg.job.endpoint_url}</code>
                      </div>
                      {leg.latestSample && (
                        <div className="metrics-grid comparison-metrics">
                          <Metric
                            metricKey="encoded_bitrate_kbps"
                            label="Bitrate"
                            value={`${leg.latestSample.encoded_bitrate_kbps.toFixed(0)} kbps`}
                          />
                          <Metric
                            metricKey="encoder_send_rate_mbps"
                            label="Send rate"
                            value={
                              leg.latestSample.encoder_send_rate_mbps
                                ? `${leg.latestSample.encoder_send_rate_mbps.toFixed(2)} Mbps`
                                : "—"
                            }
                          />
                          <Metric
                            metricKey="transport_rtt_ms"
                            label="RTT"
                            value={
                              leg.latestSample.transport_rtt_ms
                                ? `${leg.latestSample.transport_rtt_ms.toFixed(1)} ms`
                                : "—"
                            }
                          />
                          <Metric
                            metricKey="fps"
                            label="FPS"
                            value={leg.latestSample.fps.toFixed(1)}
                          />
                          <Metric
                            metricKey="client_memory_percent"
                            label="Client mem"
                            value={
                              leg.latestSample.client_memory_percent
                                ? `${leg.latestSample.client_memory_percent.toFixed(1)}%`
                                : "—"
                            }
                          />
                          {(leg.latestSample.server_cpu_percent ?? 0) > 0 && (
                            <Metric
                              metricKey="server_cpu_percent"
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

              {!loading &&
                comparisonLegs.length > 0 &&
                comparisonLegs.every((leg) => isLegFinished(leg.job, leg.ingestVmafRequested)) && (
                  <div className="session-download-strip">
                    <p className="hint">
                      Download this session’s raw metrics, or open Session Details for the scorecard.
                    </p>
                    <div className="download-actions">
                      {comparisonLegs.map((leg) => {
                        const filename = resultFilenameFromPath(leg.job.csv_path);
                        if (!filename) {
                          return null;
                        }
                        return (
                          <div key={leg.id} className="session-download-inline">
                            <span>{leg.label}</span>
                            <a className="csv-download" href={resultDownloadUrl(filename, "csv")} download>
                              CSV
                            </a>
                            <a className="csv-download" href={resultDownloadUrl(filename, "json")} download>
                              JSON
                            </a>
                          </div>
                        );
                      })}
                      <button type="button" className="secondary-button" onClick={() => setTab("metrics")}>
                        Open Session Details
                      </button>
                    </div>
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
                      psnrDb: leg.job.psnr_db,
                      ssim: leg.job.ssim,
                    }))}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {tab === "metrics" && (
          <section className="panel results-panel">
            <h2>Session Details</h2>
            <SessionMetrics streams={sessionMetrics} labels={sessionMetricLabels} />
          </section>
        )}

        {tab === "about" && <AboutPage />}
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

function formatQualityScores(
  vmaf?: number | null,
  psnrDb?: number | null,
  ssim?: number | null,
): string {
  const parts: string[] = [];
  if (vmaf != null) {
    parts.push(`VMAF ${vmaf}`);
  }
  if (psnrDb != null) {
    parts.push(`PSNR ${psnrDb} dB`);
  }
  if (ssim != null) {
    parts.push(`SSIM ${ssim}`);
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

function Metric({
  metricKey,
  label,
  value,
}: {
  metricKey: string;
  label: string;
  value: string;
}) {
  return (
    <div className="metric">
      <MetricLabel metricKey={metricKey} label={label} />
      <strong>{value}</strong>
    </div>
  );
}

export default App;
