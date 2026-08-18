import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { EndpointSection } from "./EndpointSection";
import { AboutPage, PAYPAL_DONATE_URL } from "./AboutPage";
import { SessionMetrics } from "./SessionMetrics";
import { SessionHistory } from "./SessionHistory";
import { StreamPlayer } from "./StreamPlayer";
import { defaultPlaybackModeForProtocol, moqDefaultsFromPublishUrl, proxiedMoqFingerprintUrl, relayWebTransportUrl, resolvedPlaybackMode } from "./playbackUrls";
import { playbackGateForJob, type PlaybackGate } from "./playbackGate";
import {
  encoderVmafSkipReason,
  ingestVmafSkipReason,
  qualityStatusTerminal,
  wantsEncoderVmaf,
  wantsIngestVmaf,
} from "./qualityVmaf";
import { mergePlaybackSampleIntoUploadSample } from "./playbackMetricsShared";
import { deriveEncodeAnchorEpoch } from "./metricModel";
import { startClockSkewProbe } from "./clockSkew";
import { buildComparisonVerdict } from "./comparisonVerdict";
import { assignStreamColors, protocolLabel } from "./protocolTheme";
import { TopSummaryStrip } from "./TopSummaryStrip";
import { ToastStack, useToasts } from "./Toast";
import { PipelineConfigDetails } from "./PipelineConfigDetails";
import { buildRecipePipelineSections, diagramHopsForStream } from "./pipelineConfig";
import {
  collapseOutputsForBrowserMoq,
  defaultIngestForProtocol,
  ingestCollisionKey,
  ingestEndpointLabel,
  ingestEndpointsForProtocol,
  isIngestEndpointIdAvailable,
  isCustomIngestEndpoint,
  presetIdForIngest,
  resolveEndpointUrl,
  type CloudEncodeHostId,
  type IngestEndpointId,
} from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol, ResultSummary, UploadJob, UploadSample } from "./types";
import { LIVE_WEBCAM_MAX_DURATION_SEC, webcamCaptureSeconds } from "./webcamCapture";
import { startBrowserMoqPublish, type BrowserMoqRun } from "./browserMoq/publisher";
import { detectBrowserMoqCapabilities } from "./browserMoq/capabilities";
import { moqtDraftLabel } from "./browserMoq/moqtVersions";
import {
  DEVICE_BROWSER_MEDIA,
  LOCAL_DEVICE_WEBCAM,
  BBB_MEDIA_PATH,
  SourceSection,
  type EncoderId,
  type MediaSourceId,
} from "./SourceSection";
import {
  DEFAULT_ENCODE_LADDER_ID,
  DEFAULT_MOQ_TARGET_LATENCY_MS,
  DEFAULT_TARGET_LATENCY_MS,
  ENCODE_LADDER_OPTIONS,
  clampTargetLatencyMs,
  encodeProfileSummary,
  hlsLiveSyncCount,
  hlsLiveSyncDurationSec,
  moqPlayerTargetLatencyMs,
  resolveEncodeLadder,
} from "./encodeProfiles";
import { isSafariBrowser } from "./browserDetect";
import { IconBroadcast, IconGauge, IconPlus } from "./Icons";
import { StatusDot } from "./StatusDot";
import { StepHeading } from "./StepHeading";

type Tab = "benchmark" | "metrics" | "about";

const MIN_ENDPOINTS = 2;
const MAX_ENDPOINTS = 5;
/** Fresh UI loads seed two outputs (SRT + RTMP). Users can add MoQ / WebRTC. */
const DEFAULT_ENDPOINT_COUNT = 2;

function minEndpointsForSource(source: MediaSourceId): number {
  return source === "browser_moq" ? 1 : MIN_ENDPOINTS;
}

function browserSourceCanStart(endpoints: EndpointConfig[]): boolean {
  const caps = detectBrowserMoqCapabilities();
  if (!caps.ok) {
    return false;
  }
  const needsMoq = endpoints.some((endpoint) => endpoint.protocol === "moq");
  const needsWebrtc = endpoints.some((endpoint) => endpoint.protocol === "webrtc");
  if (needsMoq && !(caps.webTransport && caps.webCodecs)) {
    return false;
  }
  if (needsWebrtc && !caps.rtcPeerConnection) {
    return false;
  }
  return true;
}

function targetLatencyMsForProtocol(protocol: string): number {
  return protocol.toLowerCase() === "moq" ? DEFAULT_MOQ_TARGET_LATENCY_MS : DEFAULT_TARGET_LATENCY_MS;
}

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

function buildDefaultEndpoints(host: CloudEncodeHostId = "gcp"): EndpointConfig[] {
  const rtmpIngest = defaultIngestForProtocol("rtmp", host);
  const srtIngest = defaultIngestForProtocol("srt", host);
  return [
    {
      id: createEndpointId(),
      protocol: "rtmp",
      ingestEndpointId: rtmpIngest,
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      playbackMode: defaultPlaybackModeForProtocol("rtmp", rtmpIngest),
      playbackDvr: false,
    },
    {
      id: createEndpointId(),
      protocol: "srt",
      ingestEndpointId: srtIngest,
      endpointUrl: "",
      vmafAvailable: false,
      serverMetricsAvailable: false,
      playbackMode: defaultPlaybackModeForProtocol("srt", srtIngest),
      playbackDvr: false,
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

function isIngestEndpointAvailable(endpoint: EndpointConfig, presets: Preset[]): boolean {
  return isIngestEndpointIdAvailable(endpoint.ingestEndpointId, endpoint.protocol, presets);
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

function isLegFinished(
  job: UploadJob,
  ingestVmafRequested: boolean,
  encoderVmafRequested = false,
): boolean {
  if (job.status === "failed") {
    return true;
  }
  if (job.status !== "completed") {
    return false;
  }
  if (encoderVmafRequested && !qualityStatusTerminal(job.encoder_vmaf_status)) {
    return false;
  }
  if (ingestVmafRequested && !qualityStatusTerminal(job.vmaf_status)) {
    return false;
  }
  return true;
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
  const targetLatencyMs = DEFAULT_TARGET_LATENCY_MS;
  // Source and encode location are coupled 1:1 (cloud playout → API host,
  // webcam → this machine) — no independent "Publisher" toggle.
  const publisherHost: "cloud" | "local" | "browser" =
    mediaSource === "webcam" ? "local" : mediaSource === "browser_moq" ? "browser" : "cloud";
  // Cloud playout always encodes on this API host (GCP us-central1).
  const encodeCloudHost = "gcp" as const;
  const [encoder, setEncoder] = useState<EncoderId>("ffmpeg");
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
  const comparisonFinishedRef = useRef(false);
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
  const [browserPreviewStream, setBrowserPreviewStream] = useState<MediaStream | null>(null);
  const [browserHasAudio, setBrowserHasAudio] = useState(false);
  const browserMoqRunRef = useRef<BrowserMoqRun | null>(null);

  function stopBrowserMoqRun() {
    browserMoqRunRef.current?.stop();
    browserMoqRunRef.current = null;
    setBrowserPreviewStream(null);
    setBrowserHasAudio(false);
    // Keep negotiated drafts so StreamPlayer does not remount from 18→16
    // (?? 16) after the publisher has already closed.
  }

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

  const outputColors = useMemo(
    () =>
      assignStreamColors(
        endpoints.map((endpoint) => ({
          protocol: endpoint.protocol,
          ingestEndpointId: endpoint.ingestEndpointId,
          playbackMode: endpoint.playbackMode,
          endpoint: endpoint.endpointUrl,
        })),
      ),
    [endpoints],
  );

  const bbbSource = features.media_sources?.find((item) => item.id === "bbb");
  const bbbAvailable = Boolean(bbbSource?.available);

  const pipelineDiagram = useMemo(() => {
    const ladder = resolveEncodeLadder(encodeLadder);
    const isLive = mediaSource === "webcam" || mediaSource === "browser_moq";
    const sourceTitle = isLive
      ? "Webcam"
      : mediaSource === "bbb"
        ? "Big Buck Bunny"
        : mediaSource === "upload"
          ? mediaLabel || "Upload"
          : "Color bars";
    const sourceDetail = mediaSource === "browser_moq"
      ? "Captured in this browser"
      : mediaSource === "webcam"
        ? "This computer’s camera"
        : "Cloud playout on the API host";
    const encodeTitle =
      mediaSource === "browser_moq"
        ? "Browser WebCodecs"
        : mediaSource === "webcam"
          ? "This computer · ffmpeg"
          : "API host · ffmpeg";
    return {
      sourceTitle,
      sourceDetail,
      encodeTitle,
      encodeDetail: ladder.label,
      streams: endpoints.map((endpoint, index) => {
        const hops = diagramHopsForStream(
          {
            label: `Output ${index + 1}`,
            protocol: endpoint.protocol,
            ingestEndpointId: endpoint.ingestEndpointId,
            playbackMode: endpoint.playbackMode,
            moqNamespace: endpoint.moqNamespace,
          },
          encodeProfileSummary(encodeLadder, targetLatencyMsForProtocol(endpoint.protocol)),
        );
        return {
          id: endpoint.id,
          label: `Output ${index + 1}`,
          protocol: endpoint.protocol,
          accentColor: outputColors[index] ?? outputColors[0],
          ...hops,
        };
      }),
    };
  }, [encodeLadder, endpoints, mediaLabel, mediaSource, outputColors]);

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
      setMediaPath(BBB_MEDIA_PATH);
      setMediaLabel("Big Buck Bunny");
    } else if (next === "upload") {
      setMediaPath("");
      setMediaLabel("Choose a local file");
      setComputeVmaf(false);
    } else if (next === "webcam") {
      setMediaLabel("Webcam");
      setMediaPath(lastMileWebcamMediaPath());
      setComputeVmaf(false);
    } else if (next === "browser_moq") {
      setMediaLabel("Webcam");
      setMediaPath(DEVICE_BROWSER_MEDIA);
      setComputeVmaf(false);
      setEndpoints((current) => collapseOutputsForBrowserMoq(current));
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
    if (mediaSource !== "browser_moq") {
      return;
    }
    setEndpoints((current) => collapseOutputsForBrowserMoq(current));
  }, [mediaSource, endpoints]);

  useEffect(() => {
    if (!apiOnline || presets.length === 0) {
      return;
    }

    setEndpoints((current) => {
      let changed = false;
      const next = current.map((endpoint) => {
        if (endpoint.protocol !== "moq" || !endpoint.ingestEndpointId.endsWith("_moq_relay")) {
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
    setEndpoints((current) => {
      let changed = false;
      const next = current.map((endpoint) => {
        const playbackMode = resolvedPlaybackMode(
          endpoint.playbackMode,
          endpoint.protocol,
          endpoint.ingestEndpointId,
        );
        if (playbackMode === endpoint.playbackMode) {
          return endpoint;
        }
        changed = true;
        return { ...endpoint, playbackMode };
      });
      return changed ? next : current;
    });
  }, [endpoints]);

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

          if (!isCustomIngestEndpoint(endpoint.ingestEndpointId) && (!presetId || !isIngestEndpointAvailable(endpoint, presets))) {
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
              isIngestEndpointAvailable(endpoint, presets) &&
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
          ? "Encoder VMAF runs on file publishes (not WHIP). Ingest VMAF needs a Zixi or MoQ recorder."
          : "Live webcam quality scoring needs ffmpeg/libvmaf on the encode host.",
      );
      return;
    }
    if (mediaSource === "browser_moq") {
      setVmafUnavailableReason(
        anyIngestVmafAvailable
          ? "Computes video quality after encode and at the ingest server. Does not apply to WebRTC."
          : "Ingest VMAF needs a managed MoQ relay with a recorder. Does not apply to WebRTC.",
      );
      return;
    }
    if (!vmafBothAvailable) {
      setVmafUnavailableReason(
        encoderVmafAvailable
          ? "Ingest VMAF needs a Zixi or MoQ recorder — encoder scores still run on file publishes except WHIP."
          : "Encoder libvmaf is unavailable — ingest scores will still run where a recorder exists.",
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
      if (mediaSource === "browser_moq") {
        const hasWebrtc = current.some((ep) => ep.protocol === "webrtc");
        if (!hasWebrtc) {
          protocol = "webrtc";
          ingestEndpointId = defaultIngestForProtocol("webrtc", encodeCloudHost);
        } else {
          protocol = protocols.find((item) => item.id === "moq")?.id ?? "moq";
          const usedRelays = new Set(
            current.filter((ep) => ep.protocol === "moq").map((ep) => ep.ingestEndpointId),
          );
          const unusedRelay = ingestEndpointsForProtocol("moq", presets).find(
            (item) =>
              item.available &&
              !isCustomIngestEndpoint(item.id) &&
              !usedRelays.has(item.id),
          );
          ingestEndpointId = unusedRelay?.id ?? defaultIngestForProtocol(protocol, encodeCloudHost);
        }
      } else if (!ingestEndpointId) {
        // Real ingest capacity exhausted for SRT/RTMP — MoQ's randomized
        // namespace per leg guarantees no collision instead of forcing a
        // known-bad duplicate onto an already-occupied path.
        protocol = protocols.find((item) => item.id === "moq")?.id ?? protocol;
        ingestEndpointId = defaultIngestForProtocol(protocol, encodeCloudHost);
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
      if (current.length <= minEndpointsForSource(mediaSource)) {
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
    publisher_host?: "cloud" | "local" | "browser";
  } {
    const presetId = resolvePresetId(endpoint);
    const isBrowserSource = resolvedMediaPath.toLowerCase().startsWith(DEVICE_BROWSER_MEDIA);
    const isLive =
      resolvedMediaPath.toLowerCase().startsWith(LOCAL_DEVICE_WEBCAM) || isBrowserSource;
    return {
      media_path: resolvedMediaPath,
      ...(durationSec != null ? { duration_sec: durationSec } : {}),
      // Webcam ingest VMAF still needs a file reference on the ingest host.
      // Browser publish uploads the in-tab bitstream as that reference.
      compute_vmaf_on_ingest: wantsIngestVmaf({
        computeVmaf,
        vmafAvailable: endpoint.vmafAvailable,
        isLive,
        isBrowserSource,
      }),
      compute_vmaf_encoder: wantsEncoderVmaf({
        computeVmaf,
        encoderVmafAvailable,
        protocol: endpoint.protocol,
        isLive,
      }),
      encode_ladder: encodeLadder,
      target_latency_ms: clampTargetLatencyMs(targetLatencyMsForProtocol(endpoint.protocol)),
      comparison_id: comparisonId,
      stream_index: streamIndex,
      stream_label: endpointLabel(endpoint, streamIndex, presets),
      publisher_host:
        publisherHost === "browser"
          ? "browser"
          : features.local_publisher
            ? publisherHost
            : "cloud",
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
              delivery_media_origin_sec:
                status.delivery_media_origin_sec ?? leg.job.delivery_media_origin_sec,
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
          const allEncoded = next.every((leg) => isEncodeFinished(leg.job));
          const wasAllEncoded = current.every((leg) => isEncodeFinished(leg.job));
          if (allEncoded && !wasAllEncoded) {
            onAllFinished?.();
          }
          if (
            next.every((leg) =>
              isLegFinished(leg.job, leg.ingestVmafRequested, leg.encoderVmafRequested),
            )
          ) {
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
    comparisonFinishedRef.current = false;
    setSessionMetrics([]);
    setSessionMetricLabels([]);
    setSelectedSessionKey(null);
    setSessionFromHistory(false);
    setLoading(true);

    const startEndpoints = endpoints.map((endpoint) => {
      if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
        return endpoint;
      }
      const options = ingestEndpointsForProtocol(endpoint.protocol, presets);
      if (options.some((item) => item.id === endpoint.ingestEndpointId)) {
        return endpoint;
      }
      const fallback = options.find((item) => item.available);
      return fallback ? { ...endpoint, ingestEndpointId: fallback.id } : endpoint;
    });
    if (startEndpoints.some((endpoint, index) => endpoint !== endpoints[index])) {
      setEndpoints(startEndpoints);
    }

    const unavailableEndpoint = startEndpoints.find(
      (endpoint) =>
        !isCustomIngestEndpoint(endpoint.ingestEndpointId) &&
        (!isIngestEndpointAvailable(endpoint, presets) || !resolvePresetId(endpoint)),
    );
    if (unavailableEndpoint) {
      const presetId = resolvePresetId(unavailableEndpoint);
      const presetName = presetId
        ? presets.find((item) => item.id === presetId)?.name
        : undefined;
      const label =
        presetName ||
        `${ingestEndpointLabel(unavailableEndpoint.ingestEndpointId)} · ${protocolLabel(unavailableEndpoint.protocol)}`;
      setError(
        `Select an available ingest endpoint (${label}) or use a custom URL.`,
      );
      setLoading(false);
      return;
    }

    const customWithoutUrl = startEndpoints.find(
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
    } else if (mediaSource === "browser_moq") {
      const caps = detectBrowserMoqCapabilities();
      if (!browserSourceCanStart(startEndpoints)) {
        setError(caps.reason || "Browser cannot publish these outputs yet.");
        setLoading(false);
        return;
      }
      const nonBrowser = startEndpoints.find(
        (endpoint) => endpoint.protocol !== "moq" && endpoint.protocol !== "webrtc",
      );
      if (nonBrowser) {
        setError("Browser publish supports MoQ and WebRTC. Remove SRT/RTMP outputs or switch source.");
        setLoading(false);
        return;
      }
    } else if (mediaSource === "upload" && !mediaPath) {
      setError("Choose a video file to upload before starting.");
      setLoading(false);
      return;
    }

    try {
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
        mediaPaths = startEndpoints.map(() => deviceMediaPath);
        durationSec = LIVE_WEBCAM_MAX_DURATION_SEC;
        setMediaPath(deviceMediaPath);
      } else if (mediaSource === "browser_moq") {
        setWebcamStatus(
          `Browser will encode and publish (auto-stops at ${LIVE_WEBCAM_MAX_DURATION_SEC / 60} min).`,
        );
        mediaPaths = startEndpoints.map(() => DEVICE_BROWSER_MEDIA);
        durationSec = LIVE_WEBCAM_MAX_DURATION_SEC;
        setMediaPath(DEVICE_BROWSER_MEDIA);
      } else {
        // VOD (color bars or an uploaded file) — cloud ffmpeg probes duration.
        mediaPaths = startEndpoints.map(() => mediaPath);
        durationSec = undefined;
      }

      const jobs = await Promise.all(
        startEndpoints.map((endpoint, index) =>
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

      if (mediaSource === "browser_moq") {
        try {
          const run = await startBrowserMoqPublish({
            legs: jobs.map((job, index) => {
              const endpoint = startEndpoints[index];
              const publishUrl = resolveEndpointUrl(endpoint, presets) || job.endpoint_url;
              if (endpoint.protocol === "webrtc") {
                return {
                  jobId: job.id,
                  protocol: "webrtc" as const,
                  whipUrl: publishUrl,
                  ingestVmaf: false,
                };
              }
              const relayUrl = endpoint.moqRelayUrl?.trim() || relayWebTransportUrl(publishUrl);
              return {
                jobId: job.id,
                protocol: "moq" as const,
                relayUrl,
                namespace: job.moq_namespace || `bench-${job.id.replace(/-/g, "").slice(0, 8)}`,
                fingerprintUrl:
                  endpoint.moqFingerprintUrl?.trim() || proxiedMoqFingerprintUrl(relayUrl),
                ingestVmaf: Boolean(computeVmaf && endpoint.vmafAvailable),
              };
            }),
          });
          browserMoqRunRef.current = run;
          setBrowserPreviewStream(run.previewStream);
          setBrowserHasAudio(run.hasAudio);
          const drafts = [...new Set(Object.values(run.draftByJobId))];
          setWebcamStatus(
            drafts.length
              ? `Publishing ${drafts.map((draft) => moqtDraftLabel(draft)).join(", ")} from the browser.`
              : "Publishing WebRTC from the browser.",
          );
        } catch (err) {
          await Promise.all(jobs.map((job) => stopUpload(job.id).catch(() => undefined)));
          throw err;
        }
      }

      const legs: ComparisonLegState[] = jobs.map((job, index) => ({
        id: job.id,
        label: endpointLabel(startEndpoints[index], index, presets),
        protocol: job.protocol,
        job,
        samples: [],
        latestSample: null,
        ingestVmafRequested: wantsIngestVmaf({
          computeVmaf,
          vmafAvailable: startEndpoints[index].vmafAvailable,
          isLive: mediaSource === "webcam" || mediaSource === "browser_moq",
          isBrowserSource: mediaSource === "browser_moq",
        }),
        encoderVmafRequested: wantsEncoderVmaf({
          computeVmaf,
          encoderVmafAvailable,
          protocol: startEndpoints[index].protocol,
          isLive: mediaSource === "webcam" || mediaSource === "browser_moq",
        }),
      }));
      setComparisonLegs(legs);
      pushToast(`Started comparison — ${startEndpoints.length} streams`, "info");

      const finish = () => {
        if (comparisonFinishedRef.current) {
          return;
        }
        comparisonFinishedRef.current = true;
        setLoading(false);
        pushToast("Comparison finished", "success");
        if (mediaSource === "webcam") {
          setWebcamStatus("Live webcam run finished.");
        } else if (mediaSource === "browser_moq") {
          stopBrowserMoqRun();
          setWebcamStatus("Browser run finished.");
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
      mediaSource === "webcam"
        ? "Stopping live webcam and encoders…"
        : mediaSource === "browser_moq"
          ? "Stopping in-browser MoQ publisher…"
          : "Stopping comparison…",
    );
    stopBrowserMoqRun();
    await Promise.all(
      comparisonLegs.map((leg) =>
        stopUpload(leg.id).catch(() => ({ ok: false, status: "error" })),
      ),
    );
  }

  const safariUnsupported = isSafariBrowser();
  const canAddBrowserMoqRelay =
    mediaSource !== "browser_moq" ||
    ingestEndpointsForProtocol("moq", presets).some(
      (item) =>
        item.available &&
        !isCustomIngestEndpoint(item.id) &&
        !endpoints.some((endpoint) => endpoint.ingestEndpointId === item.id),
    );

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
          <a className="hero-support" href={PAYPAL_DONATE_URL} target="_blank" rel="noreferrer">
            Help support this project
          </a>
          <nav className="tabs">
            <button className={tab === "benchmark" ? "active" : ""} onClick={() => setTab("benchmark")}>
              Benchmark
            </button>
            <button
              className={tab === "metrics" ? "active" : ""}
              onClick={() => setTab("metrics")}
              title="Verdict, scorecard, pipeline details, and every metric"
            >
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

              <div className="benchmark-shared-stack">
                <SourceSection
                  mediaSource={mediaSource}
                  onMediaSourceChange={handleMediaSourceChange}
                  mediaPath={mediaPath}
                  mediaLabel={mediaLabel}
                  uploadingMedia={uploadingMedia}
                  onUploadFile={handleUploadFile}
                  encoder={encoder}
                  onEncoderChange={setEncoder}
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
                  browserPreviewStream={browserPreviewStream}
                  bbbAvailable={bbbAvailable}
                  bbbHint={bbbSource?.hint ?? null}
                />

                <section className="encoder-profile-section">
                  <StepHeading
                    step={2}
                    title="Encoder & profile"
                    tip="Shared encode settings for every output — bitrate/resolution ladder and optional VMAF/PSNR/SSIM. HLS/SRT keep a 2s segmented floor; MoQ encode and playback use a 400 ms budget instead."
                  />
                  <div className="encoder-profile-body">
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
                    </div>
                    <div className="vmaf-section">
                      <h3>
                        <IconGauge size={15} className="icon-inline" /> Calculate quality
                      </h3>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={
                            computeVmaf &&
                            (mediaSource === "browser_moq"
                              ? anyIngestVmafAvailable
                              : mediaSource !== "webcam" || encoderVmafAvailable)
                          }
                          disabled={
                            !vmafSelectable ||
                            (mediaSource === "browser_moq"
                              ? !anyIngestVmafAvailable
                              : mediaSource === "webcam" && !encoderVmafAvailable)
                          }
                          onChange={(e) => setComputeVmaf(e.target.checked)}
                        />
                        <span>
                          {mediaSource === "browser_moq"
                            ? "VMAF / PSNR / SSIM after encode and at ingest (not WebRTC)"
                            : "VMAF / PSNR / SSIM at encode and after ingest"}
                        </span>
                      </label>
                      <span className="field-hint">
                        {vmafUnavailableReason ??
                          "Encoder scores every file publish except WHIP. Ingest scores need a Zixi or MoQ recorder. WebRTC is not scored."}
                      </span>
                    </div>
                  </div>
                </section>
              </div>

              <PipelineConfigDetails
                sections={pipelineSections}
                diagram={pipelineDiagram}
                buttonLabel="View pipeline config"
              />

              {error && <p className="error">{error}</p>}

              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => void handleStart()}
                  title={
                    mediaSource === "bbb" && !bbbAvailable
                      ? bbbSource?.hint ?? "Big Buck Bunny is not on this host yet."
                      : undefined
                  }
                  disabled={
                    loading ||
                    bootstrapping ||
                    !apiOnline ||
                    endpoints.length < minEndpointsForSource(mediaSource) ||
                    uploadingMedia ||
                    (mediaSource === "bbb" && !bbbAvailable) ||
                    (mediaSource === "upload" && !mediaPath) ||
                    (mediaSource === "webcam" &&
                      (!features.local_publisher || !features.local_publisher_connected)) ||
                    (mediaSource === "browser_moq" && !browserSourceCanStart(endpoints))
                  }
                >
                  {uploadingMedia
                    ? "Preparing media..."
                    : loading
                      ? "Running comparison..."
                      : endpoints.length === 1
                        ? "Start"
                        : `Start comparison (${endpoints.length} outputs)`}
                </button>
                {loading && (
                  <button
                    className="secondary-button stop-webcam-button"
                    onClick={() => void handleStopComparison()}
                  >
                    {mediaSource === "webcam"
                      ? "Stop webcam"
                      : mediaSource === "browser_moq"
                        ? "Stop publish"
                        : "Stop comparison"}
                  </button>
                )}
              </div>
            </section>

            <div className="outputs-heading-row">
              <StepHeading
                step={3}
                title="Outputs"
                tip="Each column is one protocol → ingest → playback path under the same source and encode profile. Add outputs to compare side by side; remove extras you do not need."
              />
              {endpoints.length < MAX_ENDPOINTS && canAddBrowserMoqRelay && (
                <button
                  type="button"
                  className="add-output-button"
                  onClick={addEndpoint}
                  disabled={bootstrapping || !apiOnline || loading}
                  aria-label={`Add another output (${endpoints.length} of ${MAX_ENDPOINTS})`}
                >
                  <IconPlus size={16} />
                  Add output
                  <span className="stream-add-chip-meta">
                    {endpoints.length}/{MAX_ENDPOINTS}
                  </span>
                </button>
              )}
            </div>
            <section className="benchmark-streams">
              {endpoints.map((endpoint, index) => {
                const leg = comparisonLegs[index];
                return (
                  <article
                    key={endpoint.id}
                    className="stream-column panel"
                    style={{ "--protocol-accent": outputColors[index] } as CSSProperties}
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
                      canRemove={endpoints.length > minEndpointsForSource(mediaSource)}
                      browserPublish={mediaSource === "browser_moq"}
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
                        deliveryMediaOriginSec={
                          leg?.job.delivery_media_origin_sec ?? null
                        }
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
                          leg?.job.target_latency_ms ??
                            targetLatencyMsForProtocol(endpoint.protocol),
                        )}
                        hlsLiveSyncCount={hlsLiveSyncCount(
                          leg?.job.target_latency_ms ?? targetLatencyMs,
                        )}
                        hlsLiveSyncDurationSec={hlsLiveSyncDurationSec(
                          leg?.job.target_latency_ms ?? targetLatencyMs,
                        )}
                        controlsLocked={bootstrapping || !apiOnline}
                        sourceHasAudio={mediaSource === "browser_moq" ? browserHasAudio : true}
                        moqDraftVersion={16}
                        moqMediaPackaging={mediaSource === "browser_moq" ? "loc" : "cmaf"}
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
                          {leg.encoderVmafRequested ? (
                            <div className="status-row quality">
                              <span>Encoder quality</span>
                              <div className="quality-status-stack">
                                <strong className={`pill ${leg.job.encoder_vmaf_status ?? "disabled"}`}>
                                  {formatVmafStatus(leg.job.encoder_vmaf_status)}
                                  {isQualityStatusInProgress(leg.job.encoder_vmaf_status) && (
                                    <span className="status-computing-dot" title="Computing…" />
                                  )}
                                </strong>
                                {formatQualityScores(
                                  leg.job.encoder_vmaf_score,
                                  leg.job.encoder_psnr_db,
                                  leg.job.encoder_ssim,
                                ) ? (
                                  <span className="quality-score-line">
                                    {formatQualityScores(
                                      leg.job.encoder_vmaf_score,
                                      leg.job.encoder_psnr_db,
                                      leg.job.encoder_ssim,
                                    )}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          ) : computeVmaf ? (
                            <div className="status-row quality">
                              <span>Encoder quality</span>
                              <strong className="pill disabled">n/a</strong>
                              <span className="quality-skip-reason">
                                {encoderVmafSkipReason(
                                  endpoint.protocol,
                                  mediaSource === "webcam" || mediaSource === "browser_moq",
                                )}
                              </span>
                            </div>
                          ) : null}
                          {leg.ingestVmafRequested ? (
                            <div className="status-row quality">
                              <span>Ingest quality</span>
                              <div className="quality-status-stack">
                                <strong className={`pill ${leg.job.vmaf_status ?? "disabled"}`}>
                                  {formatVmafStatus(leg.job.vmaf_status)}
                                  {isQualityStatusInProgress(leg.job.vmaf_status) && (
                                    <span className="status-computing-dot" title="Computing…" />
                                  )}
                                </strong>
                                {formatQualityScores(leg.job.vmaf_score, leg.job.psnr_db, leg.job.ssim) ? (
                                  <span className="quality-score-line">
                                    {formatQualityScores(leg.job.vmaf_score, leg.job.psnr_db, leg.job.ssim)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          ) : computeVmaf ? (
                            <div className="status-row quality">
                              <span>Ingest quality</span>
                              <strong className="pill disabled">n/a</strong>
                              <span className="quality-skip-reason">
                                {ingestVmafSkipReason({
                                  vmafAvailable: endpoint.vmafAvailable,
                                  isLive: mediaSource === "webcam" || mediaSource === "browser_moq",
                                  isBrowserSource: mediaSource === "browser_moq",
                                })}
                              </span>
                            </div>
                          ) : null}
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

            {!loading &&
              comparisonLegs.length > 0 &&
              comparisonLegs.every((leg) =>
                isLegFinished(leg.job, leg.ingestVmafRequested, leg.encoderVmafRequested),
              ) && (
                <section className="session-download-strip benchmark-download">
                  <p className="hint">
                    Charts below are a live snapshot. Open{" "}
                    <button type="button" className="link-button" onClick={() => setTab("metrics")}>
                      Results
                    </button>{" "}
                    for the full scorecard, per-output details, and every metric.
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
                <div className="live-charts-heading">
                  <h2>Comparison charts</h2>
                  <p className="hint">
                    Live preview of key series. The{" "}
                    <button type="button" className="link-button" onClick={() => setTab("metrics")}>
                      Results
                    </button>{" "}
                    tab has the verdict, scorecard, pipeline details, and the rest of the metrics.
                  </p>
                </div>
                <ComparisonCharts
                  legs={comparisonLegs.map((leg, index) => {
                    const endpoint = endpoints[index];
                    const filename = resultFilenameFromPath(leg.job.csv_path);
                    const saved =
                      filename
                        ? sessionMetrics.find((item) => item.filename === filename)
                        : sessionMetrics.find(
                            (item) =>
                              item.protocol === leg.protocol &&
                              item.endpoint === (endpoint?.endpointUrl || leg.job.endpoint_url),
                          );
                    const useSaved =
                      Boolean(saved?.rows?.length) && isEncodeFinished(leg.job);
                    return {
                    id: leg.id,
                    label: leg.label,
                    protocol: leg.protocol,
                    ingestEndpointId: endpoint?.ingestEndpointId,
                    playbackMode: endpoint?.playbackMode,
                    endpoint: endpoint?.endpointUrl || leg.job.endpoint_url,
                    samples: useSaved ? [] : leg.samples,
                    result: saved,
                    vmafScore: saved?.averages?.vmaf_score ?? leg.job.vmaf_score,
                    psnrDb: saved?.averages?.psnr_db ?? leg.job.psnr_db,
                    ssim: saved?.averages?.ssim ?? leg.job.ssim,
                    vmafScoreEncoder:
                      saved?.quality?.encoder?.vmaf_score ?? leg.job.encoder_vmaf_score,
                    psnrDbEncoder: saved?.quality?.encoder?.psnr_db ?? leg.job.encoder_psnr_db,
                    ssimEncoder: saved?.quality?.encoder?.ssim ?? leg.job.encoder_ssim,
                    vmafScoreIngest:
                      saved?.quality?.ingest?.vmaf_score ?? leg.job.vmaf_score,
                    psnrDbIngest: saved?.quality?.ingest?.psnr_db ?? leg.job.psnr_db,
                    ssimIngest: saved?.quality?.ingest?.ssim ?? leg.job.ssim,
                    encoderQualityPending:
                      leg.encoderVmafRequested &&
                      (leg.job.encoder_vmaf_status === "computing" ||
                        leg.job.encoder_vmaf_status === "waiting_for_encode"),
                    ingestQualityPending:
                      leg.ingestVmafRequested &&
                      isQualityStatusInProgress(leg.job.vmaf_status),
                    };
                  })}
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
                  Verdict, scorecard, per-output pipeline details, and every metric for this
                  comparison — more than the live charts on the Benchmark tab.
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
  if (vmaf != null && Number.isFinite(vmaf)) {
    parts.push(`VMAF ${vmaf.toFixed(1)}`);
  }
  if (psnrDb != null && Number.isFinite(psnrDb)) {
    parts.push(`PSNR ${psnrDb.toFixed(1)} dB`);
  }
  if (ssim != null && Number.isFinite(ssim)) {
    parts.push(`SSIM ${ssim.toFixed(3)}`);
  }
  return parts.join(" · ");
}

export default App;
