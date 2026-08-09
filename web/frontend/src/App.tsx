import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  checkHealth,
  createUpload,
  fetchFeatures,
  fetchPresets,
  fetchProtocols,
  fetchResultDetail,
  fetchQualityAvailable,
  fetchUpload,
  fetchVmafAvailable,
  resultFilenameFromPath,
  stopUpload,
  subscribeToUpload,
  uploadMedia,
  type FeatureFlags,
} from "./api";
import { downloadCombinedCsv, downloadCombinedJson } from "./combinedDownload";
import { ComparisonCharts } from "./ComparisonCharts";
import { EndpointSection, playerShortLabel } from "./EndpointSection";
import { AboutPage } from "./AboutPage";
import { SessionMetrics } from "./SessionMetrics";
import { SessionHistory } from "./SessionHistory";
import { StreamPlayer } from "./StreamPlayer";
import { moqDefaultsFromPublishUrl } from "./playbackUrls";
import { playbackGateForJob, type PlaybackGate } from "./playbackGate";
import { mergePlaybackSampleIntoUploadSample } from "./playbackMetricsShared";
import { deriveEncodeAnchorEpoch } from "./metricModel";
import { startClockSkewProbe } from "./clockSkew";
import { buildComparisonVerdict } from "./comparisonVerdict";
import { protocolColor, protocolLabel } from "./protocolTheme";
import { TopSummaryStrip } from "./TopSummaryStrip";
import { ToastStack, useToasts } from "./Toast";
import { PipelineConfigDetails } from "./PipelineConfigDetails";
import { buildRecipePipelineSections } from "./pipelineConfig";
import {
  INGEST_ENDPOINTS,
  defaultIngestForProtocol,
  ingestCollisionKey,
  ingestEndpointLabel,
  ingestEndpointsForProtocol,
  isCustomIngestEndpoint,
  presetIdForIngest,
  resolveEndpointUrl,
  type IngestEndpointId,
} from "./ingestEndpoints";
import { defaultPlaybackModeForProtocol } from "./playbackUrls";
import type { EndpointConfig, Preset, Protocol, ResultSummary, UploadJob, UploadSample } from "./types";
import { LIVE_WEBCAM_MAX_DURATION_SEC, webcamCaptureSeconds } from "./webcamCapture";
import {
  LOCAL_DEVICE_WEBCAM,
  SourceSection,
  type CloudEncodeHostId,
  type EncoderId,
  type MediaSourceId,
} from "./SourceSection";
import { WorkflowVisualization, type WorkflowStreamBranch } from "./WorkflowVisualization";
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
import { IconBroadcast, IconGauge } from "./Icons";
import { StatusDot } from "./StatusDot";

const ENCODER_LABEL: Record<EncoderId, string> = {
  ffmpeg: "ffmpeg",
  obs: "OBS Studio",
  wowza: "Wowza",
};

const CLOUD_ENCODE_HOST_LABEL: Record<CloudEncodeHostId, string> = {
  gcp: "GCP us-central1",
  linode: "Linode",
  aws: "AWS",
};

type Tab = "benchmark" | "metrics" | "about";

const MIN_ENDPOINTS = 2;
const MAX_ENDPOINTS = 5;
/** Fresh UI loads always seed the fair-race trio (RTMP / SRT / MoQ). */
const DEFAULT_ENDPOINT_COUNT = 3;

interface ComparisonLegState {
  id: string;
  label: string;
  protocol: string;
  job: UploadJob;
  samples: UploadSample[];
  latestSample: UploadSample | null;
  ingestVmafRequested: boolean;
  encoderVmafRequested: boolean;
  /** Wall time (ms) the job reached "completed" — drives the playback drain
   * window so players finish showing their buffered tail instead of being
   * torn down mid-motion (each leg's viewer is `latency` seconds behind the
   * encoder when it stops; hard teardown truncated that much content, which
   * read as "SRT/RTMP had issues at the end of the run"). */
  completedAtMs?: number;
}

/** How long players keep running after their encode completes, playing out
 * the buffered tail. Upstream teardown during the drain surfaces as playlist
 * 404s which the players already treat as graceful end-of-stream. */
const PLAYBACK_DRAIN_MS = 10_000;

function createEndpointId(): string {
  return `ep-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildDefaultEndpoints(): EndpointConfig[] {
  return [
    {
      id: createEndpointId(),
      protocol: "rtmp",
      ingestEndpointId: "gcp_zixi",
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      // Fast HLS (hls.js) — matches defaultPlaybackModeForProtocol; raw
      // HTTP-TS/mpegts.js stays selectable but is no longer the default.
      playbackMode: "hls",
      playbackDvr: false,
    },
    {
      id: createEndpointId(),
      protocol: "srt",
      ingestEndpointId: "gcp_mediamtx",
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      playbackMode: "ll-hls",
      playbackDvr: false,
    },
    {
      id: createEndpointId(),
      protocol: "moq",
      ingestEndpointId: "gcp_moq_relay",
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      playbackMode: "moq",
      playbackDvr: false,
      moqRelayUrl: "",
      moqNamespace: "benchmark",
      moqFingerprintUrl: "",
    },
  ];
}

function endpointLabel(
  endpoint: EndpointConfig,
  index: number,
  presets: Preset[] = [],
): string {
  const base = `Stream ${index + 1} (${endpoint.protocol.toUpperCase()})`;
  const presetId = presetIdForIngest(endpoint.ingestEndpointId, endpoint.protocol);
  const preset = presetId ? presets.find((item) => item.id === presetId) : undefined;
  if (preset?.cloud_provider && preset?.cloud_region) {
    return `${base} · ${preset.cloud_provider}/${preset.cloud_region}`;
  }
  return base;
}

function sessionDownloadStreams(
  legs: ComparisonLegState[],
): { label: string; filename: string }[] {
  return legs
    .map((leg) => ({ label: leg.label, filename: resultFilenameFromPath(leg.job.csv_path) }))
    .filter((entry): entry is { label: string; filename: string } => Boolean(entry.filename));
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

function outputStatusTone(
  leg: ComparisonLegState | undefined,
  running: boolean,
): "ok" | "warn" | "bad" | "idle" {
  if (!leg) {
    return running ? "warn" : "idle";
  }
  if (leg.job.status === "failed") {
    return "bad";
  }
  if (leg.job.status === "completed") {
    return "ok";
  }
  if (leg.job.status === "running") {
    return leg.job.preview_ready === false ? "warn" : "ok";
  }
  return "idle";
}

function isEncodeFinished(job: UploadJob): boolean {
  return job.status === "completed" || job.status === "failed";
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
  const [mediaPath, setMediaPath] = useState("dummy.mp4");
  const [mediaLabel, setMediaLabel] = useState("Default Color Bars");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [computeVmaf, setComputeVmaf] = useState(false);
  const [encodeLadder, setEncodeLadder] = useState(DEFAULT_ENCODE_LADDER_ID);
  const [targetLatencyMs, setTargetLatencyMs] = useState(DEFAULT_TARGET_LATENCY_MS);
  const [latencyDraft, setLatencyDraft] = useState(String(DEFAULT_TARGET_LATENCY_MS));
  const [latencyFocused, setLatencyFocused] = useState(false);
  // Source and encode location are coupled 1:1 (VOD → cloud, webcam → this
  // machine) — no independent "Publisher" toggle needed anymore.
  const publisherHost: "cloud" | "local" = mediaSource === "webcam" ? "local" : "cloud";
  // Presentational for now — every cloud encode still runs on the single GCP
  // API host; kept as real state so wiring a second region later is additive.
  const [encoder, setEncoder] = useState<EncoderId>("ffmpeg");
  const [encodeCloudHost, setEncodeCloudHost] = useState<CloudEncodeHostId>("gcp");
  // Last-mile camera choice ("" = agent default device).
  const [webcamDeviceIndex, setWebcamDeviceIndex] = useState("");
  const [features, setFeatures] = useState<FeatureFlags>({
    local_publisher: false,
    local_publisher_connected: false,
    local_publisher_agents: [],
  });
  const [encoderVmafAvailable, setEncoderVmafAvailable] = useState(false);
  const [encoderVmafUnavailableReason, setEncoderVmafUnavailableReason] = useState<string | null>(null);
  const [vmafUnavailableReason, setVmafUnavailableReason] = useState<string | null>(null);
  const [comparisonLegs, setComparisonLegs] = useState<ComparisonLegState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionMetrics, setSessionMetrics] = useState<ResultSummary[]>([]);
  const [sessionMetricLabels, setSessionMetricLabels] = useState<string[]>([]);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [sessionFromHistory, setSessionFromHistory] = useState(false);
  const [sessionHistoryRefreshToken, setSessionHistoryRefreshToken] = useState(0);
  const { toasts, pushToast } = useToasts();
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [apiOnline, setApiOnline] = useState(false);
  // Bumped when a leg's playback drain window expires (see PLAYBACK_DRAIN_MS);
  // the value is unused — the re-render re-evaluates drainedPlaybackGate.
  const [, setDrainTick] = useState(0);

  /** playbackGateForJob, but completed legs stay "live" for a short drain so
   * the player can finish showing what's already buffered (each viewer is
   * `latency` seconds behind the encoder — hard teardown at completion
   * truncated exactly that much content from the end of every run). */
  function drainedPlaybackGate(leg: ComparisonLegState | undefined): PlaybackGate {
    const gate = playbackGateForJob(leg?.job, loading);
    if (
      gate === "ended" &&
      leg?.job.status === "completed" &&
      leg.completedAtMs != null &&
      Date.now() - leg.completedAtMs < PLAYBACK_DRAIN_MS
    ) {
      return "live";
    }
    return gate;
  }
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [webcamStatus, setWebcamStatus] = useState<string | null>(null);

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
  const pipelineSections = useMemo(
    () => buildRecipePipelineSections(encodeLadder, targetLatencyMs, endpoints),
    [encodeLadder, targetLatencyMs, endpoints],
  );

  // Live "shape" of the run — mirrors the recipe as it's being configured, so
  // the source/encode/fanout topology is visible before pressing Start.
  const workflowStreams: WorkflowStreamBranch[] = useMemo(
    () =>
      endpoints.map((endpoint, index) => ({
        id: endpoint.id,
        label: `Output ${index + 1}`,
        protocol: protocolLabel(endpoint.protocol),
        ingestLabel: isCustomIngestEndpoint(endpoint.ingestEndpointId)
          ? "Custom URL"
          : ingestEndpointLabel(endpoint.ingestEndpointId),
        playerLabel: playerShortLabel(endpoint),
        accentColor: protocolColor(endpoint.protocol, index),
      })),
    [endpoints],
  );
  const workflowSourceTitle = mediaSource === "webcam" ? "Webcam" : "VOD asset";
  const workflowSourceDetail =
    mediaSource === "webcam"
      ? features.local_publisher_connected
        ? "This machine's camera — agent connected"
        : "This machine's camera — waiting for agent"
      : mediaSource === "dummy"
        ? "Default Color Bars"
        : mediaSource === "bbb"
          ? "Big Buck Bunny (coming soon)"
          : mediaLabel || "Choose a file to upload";
  const workflowEncodeTitle = mediaSource === "webcam" ? "This machine" : "Cloud VM";
  const workflowEncodeDetail =
    mediaSource === "webcam"
      ? "Local ffmpeg, over your real network"
      : `${CLOUD_ENCODE_HOST_LABEL[encodeCloudHost]} · ${ENCODER_LABEL[encoder]}`;

  const commitLatencyDraft = useCallback((raw: string) => {
    const parsed = Number(raw.trim());
    const next = clampTargetLatencyMs(Number.isFinite(parsed) ? parsed : DEFAULT_TARGET_LATENCY_MS);
    setTargetLatencyMs(next);
    setLatencyDraft(String(next));
  }, []);

  const nudgeLatency = useCallback((delta: number) => {
    setTargetLatencyMs((current) => {
      const next = clampTargetLatencyMs(current + delta);
      setLatencyDraft(String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!latencyFocused) {
      setLatencyDraft(String(targetLatencyMs));
    }
  }, [targetLatencyMs, latencyFocused]);

  const loadBootstrapData = useCallback(async () => {
    setBootstrapping(true);
    setBootstrapError(null);

    try {
      await checkHealth();
      setApiOnline(true);

      const [protocolData, presetData, featureData] = await Promise.all([
        fetchProtocols(),
        fetchPresets(),
        fetchFeatures().catch(() => ({
          local_publisher: false,
          local_publisher_connected: false,
          local_publisher_agents: [],
        })),
      ]);

      setProtocols(protocolData.protocols);
      setPresets(presetData.presets);
      setFeatures(featureData);
      setEndpoints((current) =>
        current.length >= DEFAULT_ENDPOINT_COUNT ? current : buildDefaultEndpoints(),
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
    // Latency anchors are server-clock epochs; align Date.now() to them.
    startClockSkewProbe();
  }, [loadBootstrapData]);

  // Poll agent connection whenever the API is up (local publish may be enabled).
  useEffect(() => {
    if (!apiOnline) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchFeatures();
        if (!cancelled) {
          setFeatures(next);
          if (!next.local_publisher && mediaSource === "webcam") {
            setMediaSource("dummy");
            setMediaPath("dummy.mp4");
            setMediaLabel("Default Color Bars");
          }
        }
      } catch {
        /* ignore transient poll errors */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [apiOnline, mediaSource]);

  // Cameras advertised by the connected agent, for the last-mile picker.
  const agentWebcamDevices =
    features.local_publisher_agents.find(
      (agent) => agent.ready && (agent.webcam_devices?.length ?? 0) > 0,
    )?.webcam_devices ?? [];

  function lastMileWebcamMediaPath(): string {
    return webcamDeviceIndex
      ? `${LOCAL_DEVICE_WEBCAM}:${webcamDeviceIndex}`
      : LOCAL_DEVICE_WEBCAM;
  }

  function handleMediaSourceChange(next: MediaSourceId) {
    setMediaSource(next);
    setWebcamStatus(null);
    if (next === "dummy") {
      setMediaPath("dummy.mp4");
      setMediaLabel("Default Color Bars");
    } else if (next === "bbb") {
      setMediaLabel("Big Buck Bunny (coming soon)");
    } else if (next === "upload") {
      setMediaPath("");
      setMediaLabel("Choose a local file");
      setComputeVmaf(false);
    } else if (next === "webcam") {
      setMediaLabel("Webcam");
      setMediaPath(lastMileWebcamMediaPath());
      setComputeVmaf(false);
    }
  }

  function handleUploadFile(file: File) {
    setUploadingMedia(true);
    setError(null);
    void uploadMedia(file)
      .then((result) => {
        setMediaPath(result.media_path);
        setMediaLabel(result.filename);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to upload media");
        setMediaPath("");
        setMediaLabel("Choose a local file");
      })
      .finally(() => setUploadingMedia(false));
  }

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
        encoderVmafAvailable
          ? "Live webcam: encoder scores compare each protocol's encode against the shared normalized camera capture. Ingest-side scoring needs a file reference and stays off."
          : "Live webcam quality scoring needs ffmpeg/libvmaf on the encode host.",
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
      // SRT/RTMP publish to a fixed stream path per ingest host (e.g. Zixi/MediaMTX
      // "benchmark") — MediaMTX shares that single path across *every* protocol on
      // the host, while Zixi keeps SRT ("SRT Test") independent from RTMP
      // ("benchmark"). Two legs occupying the same physical path collide and the
      // second publisher gets rejected outright, so pick a protocol+host combo
      // whose collision key isn't already in use by another leg. Try SRT hosts
      // first (existing default), then RTMP hosts, and only fall back to MoQ
      // (randomized namespace per leg, never collides) once real ingest capacity
      // across both protocols is exhausted.
      const usedKeys = new Set(
        current
          .map((ep) => ingestCollisionKey(ep.ingestEndpointId, ep.protocol))
          .filter((key): key is string => key !== null),
      );
      const candidateProtocols = [
        protocols.find((item) => item.id === "srt")?.id,
        protocols.find((item) => item.id === "rtmp")?.id,
      ].filter((id): id is string => Boolean(id));

      let protocol = candidateProtocols[0] ?? protocols[0]?.id ?? "srt";
      let ingestEndpointId: IngestEndpointId | undefined;
      for (const candidateProtocol of candidateProtocols) {
        const available = ingestEndpointsForProtocol(candidateProtocol, presets).filter(
          (item) => item.available && !isCustomIngestEndpoint(item.id),
        );
        const nonColliding = available.find(
          (item) => !usedKeys.has(ingestCollisionKey(item.id, candidateProtocol) ?? ""),
        );
        if (nonColliding) {
          protocol = candidateProtocol;
          ingestEndpointId = nonColliding.id;
          break;
        }
      }
      if (!ingestEndpointId) {
        // Real ingest capacity exhausted for SRT/RTMP — MoQ's randomized
        // namespace per leg guarantees no collision instead of forcing a
        // known-bad duplicate onto an already-occupied path.
        protocol = protocols.find((item) => item.id === "moq")?.id ?? protocol;
        ingestEndpointId = defaultIngestForProtocol(protocol);
      }
      return [
        ...current,
        {
          id: createEndpointId(),
          protocol,
          ingestEndpointId,
          endpointUrl: "",
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: defaultPlaybackModeForProtocol(protocol, ingestEndpointId),
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
    publisher_host?: "cloud" | "local";
  } {
    const presetId = resolvePresetId(endpoint);
    const isLive = resolvedMediaPath.toLowerCase().startsWith(LOCAL_DEVICE_WEBCAM);
    return {
      media_path: resolvedMediaPath,
      ...(durationSec != null ? { duration_sec: durationSec } : {}),
      // Ingest VMAF needs a file reference on the ingest host, so it stays
      // off for the live device-webcam source.
      compute_vmaf_on_ingest: computeVmaf && endpoint.vmafAvailable && !isLive,
      compute_vmaf_encoder: computeVmaf && encoderVmafAvailable,
      encode_ladder: encodeLadder,
      target_latency_ms: clampTargetLatencyMs(targetLatencyMs),
      comparison_id: comparisonId,
      stream_index: streamIndex,
      stream_label: endpointLabel(endpoint, streamIndex, presets),
      publisher_host: features.local_publisher ? publisherHost : "cloud",
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
              // The initial GET snapshots preview_ready=false for gated presets
              // (MediaMTX / managed Zixi SRT) — without this, the SSE stream
              // never tells the player it flipped true and playback never starts.
              preview_ready: status.preview_ready ?? leg.job.preview_ready,
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
              // The one-shot GET in subscribeLeg fires before the encoder's
              // first live sample, so these anchors are null there — without
              // refreshing them here deriveEncodeAnchorEpoch() stays null for
              // the whole run and RTMP HTTP-TS e2e_latency_ms is always 0.
              started_at_epoch: status.started_at_epoch ?? leg.job.started_at_epoch,
              first_sample_at_epoch:
                status.first_sample_at_epoch ?? leg.job.first_sample_at_epoch,
              media_zero_epoch: status.media_zero_epoch ?? leg.job.media_zero_epoch,
              packager_transit_ms:
                status.packager_transit_ms ?? leg.job.packager_transit_ms,
            };
            let completedAtMs = leg.completedAtMs;
            if (completedAtMs == null && updatedJob.status === "completed") {
              completedAtMs = Date.now();
              // Re-render when the drain window expires so the gate actually
              // flips to "ended" (no status event arrives at that moment).
              window.setTimeout(
                () => setDrainTick((tick) => tick + 1),
                PLAYBACK_DRAIN_MS + 250,
              );
            }
            return {
              ...leg,
              job: updatedJob,
              latestSample: leg.latestSample,
              completedAtMs,
            };
          });
          if (next.every((leg) => isEncodeFinished(leg.job))) {
            onAllFinished?.();
          }
          if (next.every((leg) => isLegFinished(leg.job, leg.ingestVmafRequested))) {
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
        const comparisonId = details[0]?.summary_extra?.comparison_id?.trim();
        setSelectedSessionKey(comparisonId || `single:${entries[0].filename}`);
        setSessionFromHistory(false);
        setSessionHistoryRefreshToken((token) => token + 1);
        // Stay on Benchmark so player diagnostics remain visible after the run.
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
    setSelectedSessionKey(null);
    setSessionFromHistory(false);
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

    if (mediaSource === "webcam") {
      if (!features.local_publisher) {
        setError("Webcam requires the local publisher agent, which is not enabled on this deployment.");
        setLoading(false);
        return;
      }
      if (!features.local_publisher_connected) {
        setError(
          "No local publisher agent connected. Run the agent command shown under Webcam, then retry.",
        );
        setLoading(false);
        return;
      }
    } else if (mediaSource === "upload" && !mediaPath) {
      setError("Choose a video file to upload before starting.");
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

      if (mediaSource === "webcam") {
        // setLoading(true) above already flips WebcamLivePreview's `running`
        // prop, which stops its getUserMedia tracks — but that happens on
        // the next render, asynchronously. Give the OS a beat to actually
        // release the device before the agent's ffmpeg tries to open it
        // exclusively, or the two consumers can race on some platforms.
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        setWebcamStatus(
          `Agent will open this machine’s camera — press Stop when finished (auto-stops at ${LIVE_WEBCAM_MAX_DURATION_SEC / 60} min).`,
        );
        const deviceMediaPath = lastMileWebcamMediaPath();
        mediaPaths = endpoints.map(() => deviceMediaPath);
        durationSec = LIVE_WEBCAM_MAX_DURATION_SEC;
        setMediaPath(deviceMediaPath);
      } else {
        // VOD (color bars or an uploaded file) — cloud ffmpeg probes duration.
        mediaPaths = endpoints.map(() => mediaPath);
        durationSec = undefined;
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
        label: endpointLabel(endpoints[index], index, presets),
        protocol: job.protocol,
        job,
        samples: [],
        latestSample: null,
        ingestVmafRequested:
          computeVmaf && endpoints[index].vmafAvailable && mediaSource !== "webcam",
        encoderVmafRequested: computeVmaf && encoderVmafAvailable,
      }));
      setComparisonLegs(legs);
      pushToast(`Started comparison — ${endpoints.length} streams`, "info");

      const finish = () => {
        setLoading(false);
        pushToast("Comparison finished", "success");
        if (mediaSource === "webcam") {
          setWebcamStatus("Live webcam run finished.");
        }
      };
      jobs.forEach((job, index) => {
        subscribeLeg(job, legs[index].ingestVmafRequested, finish);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start upload";
      setError(message);
      pushToast(message, "error");
      setLoading(false);
      setUploadingMedia(false);
    }
  }

  async function handleStopComparison() {
    pushToast("Stopping comparison…", "info");
    setWebcamStatus(
      mediaSource === "webcam" ? "Stopping live webcam and encoders…" : "Stopping comparison…",
    );
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
        <div className="hero-brand">
          <span className="hero-mark" aria-hidden="true">
            <IconBroadcast size={20} />
          </span>
          <div>
            <p className="eyebrow">Streaming benchmark toolkit</p>
            <h1>MoQ Bench</h1>
          </div>
        </div>
        <div className="hero-right">
          <StatusDot
            tone={bootstrapping ? "idle" : apiOnline ? "ok" : "bad"}
            label={bootstrapping ? "Connecting…" : apiOnline ? "API online" : "API offline"}
            className="hero-api-status"
          />
          <nav className="tabs">
            <button className={tab === "benchmark" ? "active" : ""} onClick={() => setTab("benchmark")}>
              Benchmark
            </button>
            <button className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
              Results{sessionMetrics.length > 0 ? ` (${sessionMetrics.length})` : ""}
            </button>
            <button className={tab === "about" ? "active" : ""} onClick={() => setTab("about")}>
              About
            </button>
          </nav>
        </div>
      </header>

      {bootstrapError && (
        <div className="error-box api-banner">
          <strong>API unavailable.</strong> {bootstrapError}
          <button className="retry-button" onClick={() => void loadBootstrapData()}>
            Retry connection
          </button>
        </div>
      )}

      {(loading ||
        comparisonLegs.some((leg) => leg.samples.length > 0) ||
        (!loading && sessionMetrics.length >= 2)) && (
        <TopSummaryStrip
          legs={comparisonLegs}
          running={loading}
          verdict={
            !loading && sessionMetrics.length >= 2
              ? buildComparisonVerdict(sessionMetrics, sessionMetricLabels)
              : null
          }
        />
      )}

      <main>
        {tab === "benchmark" && (
          <>
            <section className="panel benchmark-shared">
              <div className="benchmark-shared-header">
                <div>
                  <h2>Benchmark</h2>
                  <p className="hint">
                    Compare publishing protocols, ingest endpoints, and upload performance in a single, standardized
                    test.
                  </p>
                </div>
              </div>

              <div className="benchmark-shared-grid">
                <SourceSection
                  mediaSource={mediaSource}
                  onMediaSourceChange={handleMediaSourceChange}
                  mediaPath={mediaPath}
                  mediaLabel={mediaLabel}
                  uploadingMedia={uploadingMedia}
                  onUploadFile={handleUploadFile}
                  encoder={encoder}
                  onEncoderChange={setEncoder}
                  encodeCloudHost={encodeCloudHost}
                  onEncodeCloudHostChange={setEncodeCloudHost}
                  features={features}
                  webcamDeviceIndex={webcamDeviceIndex}
                  onWebcamDeviceIndexChange={(index) => {
                    setWebcamDeviceIndex(index);
                    setMediaPath(index ? `${LOCAL_DEVICE_WEBCAM}:${index}` : LOCAL_DEVICE_WEBCAM);
                  }}
                  agentWebcamDevices={agentWebcamDevices}
                  captureMinutes={webcamCaptureSeconds() / 60}
                  webcamStatus={webcamStatus}
                  disabled={bootstrapping || !apiOnline || loading}
                  running={loading}
                />

                <div className="source-media-section">
                  <div className="step-heading">
                    <span className="step-badge">2</span>
                    <h3>Encoder &amp; profile</h3>
                  </div>
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
                      <div className="latency-input-row">
                        <button
                          type="button"
                          className="latency-nudge"
                          disabled={bootstrapping || !apiOnline || loading}
                          onClick={() => nudgeLatency(-100)}
                          aria-label="Decrease latency by 100 ms"
                        >
                          −100
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          autoComplete="off"
                          spellCheck={false}
                          value={latencyDraft}
                          disabled={bootstrapping || !apiOnline || loading}
                          onFocus={() => setLatencyFocused(true)}
                          onChange={(e) => {
                            const next = e.target.value.replace(/[^\d]/g, "");
                            setLatencyDraft(next);
                          }}
                          onBlur={(e) => {
                            setLatencyFocused(false);
                            commitLatencyDraft(e.target.value);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.currentTarget.blur();
                            } else if (e.key === "ArrowUp") {
                              e.preventDefault();
                              nudgeLatency(e.shiftKey ? 100 : 50);
                            } else if (e.key === "ArrowDown") {
                              e.preventDefault();
                              nudgeLatency(e.shiftKey ? -100 : -50);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="latency-nudge"
                          disabled={bootstrapping || !apiOnline || loading}
                          onClick={() => nudgeLatency(100)}
                          aria-label="Increase latency by 100 ms"
                        >
                          +100
                        </button>
                      </div>
                      <span className="field-hint">
                        {MIN_TARGET_LATENCY_MS}–{MAX_TARGET_LATENCY_MS} ms · applies to every output below
                      </span>
                    </label>
                  </div>
                </div>

                <div className="vmaf-section">
                  <h3>
                    <IconGauge size={15} className="icon-inline" /> Calculate Quality
                  </h3>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={computeVmaf && (mediaSource !== "webcam" || encoderVmafAvailable)}
                      disabled={!vmafSelectable || (mediaSource === "webcam" && !encoderVmafAvailable)}
                      onChange={(e) => setComputeVmaf(e.target.checked)}
                    />
                    <span>VMAF / PSNR / SSIM (encoder + ingest)</span>
                  </label>
                  {vmafUnavailableReason && <span className="field-hint">{vmafUnavailableReason}</span>}
                </div>
              </div>

              <WorkflowVisualization
                sourceTitle={workflowSourceTitle}
                sourceDetail={workflowSourceDetail}
                encodeTitle={workflowEncodeTitle}
                encodeDetail={workflowEncodeDetail}
                streams={workflowStreams}
              />

              <PipelineConfigDetails
                sections={pipelineSections}
                buttonLabel="View pipeline config"
              />

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
                    mediaSource === "bbb" ||
                    (mediaSource === "upload" && !mediaPath) ||
                    (mediaSource === "webcam" &&
                      (!features.local_publisher || !features.local_publisher_connected))
                  }
                >
                  {uploadingMedia
                    ? "Preparing media..."
                    : loading
                      ? "Running comparison..."
                      : `Start comparison (${endpoints.length} outputs)`}
                </button>
                {loading && (
                  <button
                    className="secondary-button stop-webcam-button"
                    onClick={() => void handleStopComparison()}
                  >
                    {mediaSource === "webcam" ? "Stop webcam" : "Stop comparison"}
                  </button>
                )}
              </div>
            </section>

            <div className="step-heading">
              <span className="step-badge">3</span>
              <h3>Outputs</h3>
            </div>
            <section className="benchmark-streams">
              {endpoints.map((endpoint, index) => {
                const leg = comparisonLegs[index];
                return (
                  <article
                    key={endpoint.id}
                    className="stream-column panel"
                    style={{ "--protocol-accent": protocolColor(endpoint.protocol, index) } as CSSProperties}
                  >
                    <StatusDot
                      tone={outputStatusTone(leg, loading)}
                      pulse={leg?.job.status === "running"}
                      className="output-card-status-dot"
                    />
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

                    <div className="stream-column-preview">
                      <StreamPlayer
                        key={`${endpoint.id}:${endpoint.playbackMode ?? "default"}:${endpoint.protocol}:${endpoint.ingestEndpointId}`}
                        title={`Output ${index + 1}`}
                        compactHeader
                        protocol={endpoint.protocol}
                        endpointUrl={resolveEndpointUrl(endpoint, presets)}
                        ingestEndpointId={endpoint.ingestEndpointId}
                        playbackMode={endpoint.playbackMode}
                        playbackDvr={false}
                        whepPlaybackUrl={endpoint.whepPlaybackUrl}
                        moqRelayUrl={endpoint.moqRelayUrl}
                        moqFingerprintUrl={endpoint.moqFingerprintUrl}
                        moqNamespace={
                          leg?.job.moq_namespace ?? (leg ? undefined : endpoint.moqNamespace)
                        }
                        zixiStreamId={leg?.job.zixi_stream_id ?? undefined}
                        zixiPlaybackStreamId={leg?.job.zixi_playback_stream_id ?? undefined}
                        encodeLadder={leg?.job.encode_ladder ?? encodeLadder}
                        playbackGate={drainedPlaybackGate(leg)}
                        jobId={leg?.job.id}
                        // Anchor preference: media_zero_epoch (encoder spawn,
                        // stamped server-side) > out_time-derived fallback.
                        // Never started_at_epoch: that predates protocol setup
                        // + webcam-broker warmup (~6s) and inflates latency.
                        encodeStartedAtEpoch={deriveEncodeAnchorEpoch(
                          leg?.job,
                          leg?.samples,
                        )}
                        packagerTransitMs={leg?.job.packager_transit_ms ?? null}
                        encoderLagMs={leg?.latestSample?.encode_lag_ms ?? 0}
                        onPlaybackSample={(playback) => {
                          const jobId = comparisonLegs[index]?.job.id;
                          if (!jobId) {
                            return;
                          }
                          setComparisonLegs((current) =>
                            current.map((item) =>
                              item.id === jobId
                                ? {
                                    ...item,
                                    samples: mergePlaybackSampleIntoUploadSample(
                                      item.samples,
                                      playback,
                                    ),
                                  }
                                : item,
                            ),
                          );
                        }}
                        jobStatus={leg?.job.status}
                        benchmarkLoading={loading}
                        encodeDurationSec={leg?.job.duration_sec ?? 60}
                        targetLatencyMs={moqPlayerTargetLatencyMs(
                          leg?.job.target_latency_ms ?? targetLatencyMs,
                        )}
                        hlsLiveSyncCount={hlsLiveSyncCount(
                          leg?.job.target_latency_ms ?? targetLatencyMs,
                        )}
                        hlsLiveSyncDurationSec={hlsLiveSyncDurationSec(
                          leg?.job.target_latency_ms ?? targetLatencyMs,
                        )}
                        controlsLocked={bootstrapping || !apiOnline}
                        // Webcam is always captured by the local-agent path (ffmpeg
                        // AVFoundation/V4L2), which always includes an audio input,
                        // same as VOD sources — sourceHasAudio defaults to true.
                        onPlaybackModeChange={(mode) =>
                          updateEndpoint(endpoint.id, { playbackMode: mode })
                        }
                        onWhepPlaybackUrlChange={(url) =>
                          updateEndpoint(endpoint.id, { whepPlaybackUrl: url })
                        }
                      />
                    </div>

                    <div className="stream-column-status">
                      {leg ? (
                        <>
                          <div className="status-row">
                            <span>Status</span>
                            <strong className={`pill ${leg.job.status}`}>{leg.job.status}</strong>
                          </div>
                          <div className="status-row">
                            <span>Job</span>
                            <code>{leg.job.id.slice(0, 8)}</code>
                          </div>
                          {leg.job.status === "failed" && leg.job.error && (
                            <p className="error">{leg.job.error}</p>
                          )}
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
                                {isQualityStatusInProgress(leg.job.encoder_vmaf_status) && (
                                  <span className="status-computing-dot" title="Computing…" />
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
                                {isQualityStatusInProgress(leg.job.vmaf_status) && (
                                  <span className="status-computing-dot" title="Computing…" />
                                )}
                              </strong>
                            </div>
                          )}
                          {leg.job.encoder_vmaf_error && (
                            <p className="error">{leg.job.encoder_vmaf_error}</p>
                          )}
                          {leg.job.vmaf_error && <p className="error">{leg.job.vmaf_error}</p>}
                        </>
                      ) : loading ? (
                        <div className="skeleton-shimmer" style={{ height: 64, borderRadius: 12 }} />
                      ) : (
                        <p className="muted stream-status-idle">Waiting to start</p>
                      )}
                    </div>
                  </article>
                );
              })}

            </section>

            {endpoints.length < MAX_ENDPOINTS && (
              <div className="benchmark-add-stream-row">
                <button
                  type="button"
                  className="stream-add-chip"
                  onClick={addEndpoint}
                  disabled={bootstrapping || !apiOnline || loading}
                  aria-label={`Add another output (${endpoints.length} of ${MAX_ENDPOINTS})`}
                >
                  <span className="stream-add-chip-icon" aria-hidden="true">
                    +
                  </span>
                  Add output
                  <span className="stream-add-chip-meta">
                    {endpoints.length}/{MAX_ENDPOINTS}
                  </span>
                </button>
              </div>
            )}

            {!loading &&
              comparisonLegs.length > 0 &&
              comparisonLegs.every((leg) => isLegFinished(leg.job, leg.ingestVmafRequested)) && (
                <section className="session-download-strip benchmark-download">
                  <p className="hint">
                    Download raw metrics, or open Results for the verdict and scorecard.
                  </p>
                  <div className="download-actions">
                    <button
                      type="button"
                      className="csv-download"
                      onClick={() =>
                        void downloadCombinedCsv(
                          sessionDownloadStreams(comparisonLegs),
                          "comparison.csv",
                        )
                      }
                    >
                      Download CSV
                    </button>
                    <button
                      type="button"
                      className="csv-download"
                      onClick={() =>
                        void downloadCombinedJson(
                          sessionDownloadStreams(comparisonLegs),
                          "comparison.json",
                        )
                      }
                    >
                      Download JSON
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setTab("metrics")}
                    >
                      Open Results
                    </button>
                  </div>
                </section>
              )}

            {(loading || comparisonLegs.some((leg) => leg.samples.length > 0)) && (
              <section className="panel live-charts-panel">
                <h2>Comparison charts</h2>
                <ComparisonCharts
                  legs={comparisonLegs.map((leg) => ({
                    id: leg.id,
                    label: leg.label,
                    protocol: leg.protocol,
                    samples: leg.samples,
                    vmafScore: leg.job.vmaf_score,
                    psnrDb: leg.job.psnr_db,
                    ssim: leg.job.ssim,
                    vmafScoreEncoder: leg.job.encoder_vmaf_score,
                    psnrDbEncoder: leg.job.encoder_psnr_db,
                    ssimEncoder: leg.job.encoder_ssim,
                    vmafScoreIngest: leg.job.vmaf_score,
                    psnrDbIngest: leg.job.psnr_db,
                    ssimIngest: leg.job.ssim,
                  }))}
                />
              </section>
            )}
          </>
        )}

        {tab === "metrics" && (
          <section className="panel results-panel">
            <div className="results-panel-header">
              <div>
                <h2>Results</h2>
                <p className="hint results-panel-lede">
                  Verdict and scorecard for the selected comparison — use past sessions to revisit
                  protocol and host trade-offs.
                </p>
              </div>
              <SessionHistory
                refreshToken={sessionHistoryRefreshToken}
                selectedKey={selectedSessionKey}
                onSelect={(summaries, labels, key) => {
                  setSessionMetrics(summaries);
                  setSessionMetricLabels(labels);
                  setSelectedSessionKey(key);
                  setSessionFromHistory(true);
                }}
              />
            </div>
            <SessionMetrics
              streams={sessionMetrics}
              labels={sessionMetricLabels}
              fromHistory={sessionFromHistory}
            />
          </section>
        )}

        {tab === "about" && <AboutPage />}
      </main>

      <ToastStack toasts={toasts} />
    </div>
  );
}

function formatVmafStatus(status?: string | null): string {
  if (!status || status === "disabled") {
    return "disabled";
  }
  return status.replaceAll("_", " ");
}

/** True while a quality score is actively queued/uploading/computing (not yet
 * a final completed/failed/disabled state) — used to show the pulsing dot. */
function isQualityStatusInProgress(status?: string | null): boolean {
  return (
    status === "computing" ||
    status === "uploading_reference" ||
    status === "waiting_for_upload" ||
    status === "waiting_for_encode"
  );
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

export default App;
