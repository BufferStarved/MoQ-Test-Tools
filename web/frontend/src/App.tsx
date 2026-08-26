import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  checkHealth,
  createUpload,
  fetchFeatures,
  mintPublisherSession,
  fetchPresets,
  fetchProtocols,
  fetchResultDetail,
  fetchResults,
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
import { AboutPage, PAYPAL_DONATE_URL } from "./AboutPage";
import { ResultsErrorBoundary } from "./ResultsErrorBoundary";
import { SessionMetrics } from "./SessionMetrics";
import { SessionHistory } from "./SessionHistory";
import { StreamPlayer } from "./StreamPlayer";
import { moqDefaultsFromPublishUrl, proxiedMoqFingerprintUrl, relayWebTransportUrl } from "./playbackUrls";
import { playbackGateForJob, type PlaybackGate } from "./playbackGate";
import {
  qualityStatusTerminal,
  wantsEncoderVmaf,
  wantsIngestVmaf,
} from "./qualityVmaf";
import {
  mergeEncoderSampleWithLivePlayback,
  mergePlaybackSampleIntoUploadSample,
  overlayPlaybackOnLatestSample,
} from "./playbackMetricsShared";
import { deriveEncodeAnchorEpoch } from "./metricModel";
import { humanizeJobError } from "./moqCmafPlayback";
import { encodeElapsedSecForVerdict } from "./playbackEndVerdict";
import { startClockSkewProbe } from "./clockSkew";
import { assignStreamColors, protocolLabel } from "./protocolTheme";
import { ToastStack, useToasts } from "./Toast";
import { PipelineConfigDetails } from "./PipelineConfigDetails";
import { buildRecipePipelineSections, diagramHopsForStream } from "./pipelineConfig";
import {
  ingestEndpointLabel,
  isIngestEndpointIdAvailable,
  isCustomIngestEndpoint,
  moqDraftForIngest,
  moqPinTlsCertForIngest,
  presetIdForIngest,
  resolveEndpointUrl,
  type IngestEndpointId,
} from "./ingestEndpoints";
import {
  applyEndpointPatch,
  canAddRecipeOutput,
  coerceRecipe,
  defaultRecipeEndpoints,
  isLocalAgentSource,
  nextAddableEndpoint,
  obsMoqSupported,
  publishProtocolIdsForSource,
  recipeIssue,
  RECIPE_CHROME_CAPS,
  siblingOccupiedCollisionKeys,
  type PublishProtocolId,
  type RecipeContext,
} from "./recipeSupport";
import type { EndpointConfig, Preset, Protocol, ResultSummary, UploadJob, UploadSample } from "./types";
import { LIVE_WEBCAM_MAX_DURATION_SEC, webcamCaptureSeconds } from "./webcamCapture";
import { startBrowserMoqPublish, type BrowserMoqRun } from "./browserMoq/publisher";
import { detectBrowserMoqCapabilities } from "./browserMoq/capabilities";
import { moqtDraftLabel } from "./browserMoq/moqtVersions";
import {
  DEVICE_BROWSER_MEDIA,
  LOCAL_DEVICE_WEBCAM,
  BBB_MEDIA_PATH,
  CLOUD_PLAYOUT_DURATION_SEC,
  OBS_OPENMOQ_MEDIA,
  SourceSection,
  encoderModeExplainer,
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
import { IconBroadcast, IconCpu, IconMonitor, IconPlus } from "./Icons";
import { StatusDot } from "./StatusDot";
import { StepHeading } from "./StepHeading";
import { operatorEndpoints, parseOperatorSearch } from "./operatorRecipe";
import {
  applyBenchmarkPreset,
  BENCHMARK_PRESET_DEFS,
  cloudCompareProtocolHint,
  cloudCompareProtocolLabel,
  recipeDef,
  recipeLockedSummary,
  recipeLocksProtocolMix,
  recipeShowsEndpointPickers,
  recipeShowsSharedProtocolPicker,
  wizardStepVisible,
  type BenchmarkPresetId,
} from "./benchmarkPresets";
import { SetupStepFrame } from "./SetupStepFrame";
import {
  firstStepAfterRecipe,
  isLastSetupStep,
  nextSetupStep,
  setupFlagsForPreset,
  setupStepState,
  setupStepsForRecipe,
  type SetupStepId,
} from "./setupWizard";
import { captureClassHintMs, compareLiveMetrics, resolveSampleE2eScope } from "./comparisonVerdict";
import { PlayerHud } from "./PlayerHud";
import {
  DEFAULT_PLAYBACK_POLICY,
  PLAYBACK_POLICY_COMPLETE,
  PLAYBACK_POLICY_COMPLETE_COPY,
  PLAYBACK_POLICY_LIVE_COPY,
  PLAYBACK_POLICY_LIVE_EDGE,
  parsePlaybackPolicy,
  playbackPolicyToggleVisible,
  type PlaybackPolicy,
} from "./playbackPolicy";
import {
  DEFAULT_TEST_SCOPE,
  TEST_SCOPE_E2E,
  TEST_SCOPE_E2E_COPY,
  TEST_SCOPE_UPLOAD,
  TEST_SCOPE_UPLOAD_COPY,
  isUploadOnlyScope,
  testScopeBanner,
  type TestScope,
} from "./testScope";

type Tab = "benchmark" | "metrics" | "about";

const MIN_ENDPOINTS = 1;
const MAX_ENDPOINTS = 6;

function minEndpointsForSource(_source: MediaSourceId): number {
  return MIN_ENDPOINTS;
}

function sharedOutputProtocol(endpoints: EndpointConfig[]): PublishProtocolId | undefined {
  const protocol = endpoints[0]?.protocol;
  if (!protocol || !endpoints.every((endpoint) => endpoint.protocol === protocol)) {
    return undefined;
  }
  return protocol as PublishProtocolId;
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

const operatorPlan = parseOperatorSearch(
  typeof window !== "undefined" ? window.location.search : "",
);
const PUBLISHER_SESSION_KEY = "moq-publisher-session";

function readPublisherSession(): string {
  try {
    return sessionStorage.getItem(PUBLISHER_SESSION_KEY) || "";
  } catch {
    return "";
  }
}

function writePublisherSession(sessionId: string): void {
  try {
    sessionStorage.setItem(PUBLISHER_SESSION_KEY, sessionId);
  } catch {
    /* ignore quota / private mode */
  }
}

function buildDefaultEndpoints(ctx: RecipeContext = {
  source: "dummy",
  presets: [],
  caps: RECIPE_CHROME_CAPS,
}): EndpointConfig[] {
  return defaultRecipeEndpoints(ctx).map((endpoint) => ({
    ...endpoint,
    id: createEndpointId(),
  }));
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
  if (leg.job.status === "queued" || leg.job.status === "pending") {
    return "warn";
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
  const [mediaSource, setMediaSource] = useState<MediaSourceId>(() => {
    if (operatorPlan.encoder === "browser") {
      return "browser_moq";
    }
    return operatorPlan.source ?? "dummy";
  });
  const [mediaPath, setMediaPath] = useState(() => {
    if (operatorPlan.encoder === "browser" || operatorPlan.source === "browser_moq") {
      return DEVICE_BROWSER_MEDIA;
    }
    if (operatorPlan.source === "webcam") {
      return LOCAL_DEVICE_WEBCAM;
    }
    if (operatorPlan.source === "bbb") {
      return BBB_MEDIA_PATH;
    }
    return "dummy.mp4";
  });
  const [mediaLabel, setMediaLabel] = useState(() => {
    if (operatorPlan.encoder === "browser" || operatorPlan.source === "browser_moq") {
      return "Browser camera";
    }
    if (operatorPlan.source === "webcam") {
      return "Webcam";
    }
    if (operatorPlan.source === "bbb") {
      return "Big Buck Bunny";
    }
    return "Default Color Bars";
  });
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [computeVmaf, setComputeVmaf] = useState(false);
  const [encodeLadder, setEncodeLadder] = useState(DEFAULT_ENCODE_LADDER_ID);
  const [playbackPolicy, setPlaybackPolicy] = useState<PlaybackPolicy>(DEFAULT_PLAYBACK_POLICY);
  const [testScope, setTestScope] = useState<TestScope>(DEFAULT_TEST_SCOPE);
  const [encoder, setEncoder] = useState<EncoderId>(
    operatorPlan.encoder ?? (operatorPlan.source === "browser_moq" ? "browser" : "ffmpeg"),
  );
  const [activePresetId, setActivePresetId] = useState<BenchmarkPresetId | null>(() =>
    operatorPlan.source || operatorPlan.encoder || operatorPlan.outputs.length > 0
      ? "build-your-own"
      : null,
  );
  const [setupCursor, setSetupCursor] = useState<SetupStepId>(() => {
    const initialPreset =
      operatorPlan.source || operatorPlan.encoder || operatorPlan.outputs.length > 0
        ? "build-your-own"
        : null;
    if (!initialPreset) {
      return "recipe";
    }
    return firstStepAfterRecipe(setupStepsForRecipe(setupFlagsForPreset(initialPreset)));
  });
  const targetLatencyMs = DEFAULT_TARGET_LATENCY_MS;
  // Source and encode location are coupled 1:1 (cloud playout → API host,
  // webcam → this machine) — no independent "Publisher" toggle.
  // OBS is a last-mile encoder option on Webcam, not a replacement for ffmpeg.
  const publisherHost: "cloud" | "local" | "browser" =
    encoder === "obs" || mediaSource === "webcam"
      ? "local"
      : mediaSource === "browser_moq"
        ? "browser"
        : "cloud";
  const [publisherSession, setPublisherSession] = useState(readPublisherSession);
  const recipeCaps = useMemo(() => {
    const detected = detectBrowserMoqCapabilities();
    return {
      safari: isSafariBrowser(),
      webTransport: detected.webTransport,
      rtcPeerConnection: detected.rtcPeerConnection,
    };
  }, []);
  const [features, setFeatures] = useState<FeatureFlags>({
    local_publisher: false,
    local_publisher_connected: false,
    local_publisher_agents: [],
  });
  const recipeContext = useMemo(
    (): RecipeContext => ({
      source: mediaSource,
      presets,
      caps: recipeCaps,
      publisher: { localFfmpegWhip: Boolean(features.local_publisher_whip) },
      encoder,
    }),
    [mediaSource, presets, recipeCaps, features.local_publisher_whip, encoder],
  );
  const recipeBlockReason = recipeIssue(endpoints, recipeContext);
  const obsEncoderSupported = obsMoqSupported(recipeContext);
  // Last-mile camera choice ("" = agent default device).
  const [webcamDeviceIndex, setWebcamDeviceIndex] = useState("");
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
  const comparisonJobIdsRef = useRef<string[]>([]);
  const stopRequestedRef = useRef(false);
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
  const [browserVideoCodec, setBrowserVideoCodec] = useState<string>("");
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
    () =>
      buildRecipePipelineSections(
        encodeLadder,
        targetLatencyMs,
        endpoints,
        publisherHost === "browser"
          ? "browser"
          : encoder === "obs"
            ? "obs"
            : publisherHost === "local"
              ? "ffmpeg-local"
              : "ffmpeg",
      ),
    [encodeLadder, encoder, endpoints, publisherHost, targetLatencyMs],
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
    const isLive =
      encoder === "obs" || isLocalAgentSource(mediaSource) || mediaSource === "browser_moq";
    const sourceTitle = isLive
      ? mediaSource === "browser_moq"
        ? "Browser camera"
        : "Webcam"
      : mediaSource === "bbb"
        ? "Big Buck Bunny"
        : mediaSource === "upload"
          ? mediaLabel || "Upload"
          : "Color bars";
    const sourceDetail =
      mediaSource === "browser_moq"
        ? "Captured and encoded in this tab"
        : mediaSource === "webcam" && encoder === "obs"
          ? "This laptop. OBS encodes the scene (plugin + extra outputs)."
          : mediaSource === "webcam"
            ? "This laptop’s camera, encoded by the helper app"
            : "Cloud playout on the server";
    const encodeTitle =
      mediaSource === "browser_moq"
        ? "Browser encode"
        : encoder === "obs"
          ? "OBS"
          : isLocalAgentSource(mediaSource)
            ? "This laptop"
            : "Server ffmpeg";
    const encodeDetail =
      mediaSource === "browser_moq"
        ? endpoints.some((endpoint) => endpoint.protocol === "webrtc") &&
          endpoints.some((endpoint) => endpoint.protocol === "moq")
          ? "WebCodecs (MoQ) · native WebRTC (WHIP)"
          : endpoints.some((endpoint) => endpoint.protocol === "webrtc")
            ? "Native WebRTC (WHIP)"
            : "WebCodecs H.264"
        : ladder.label;
    return {
      sourceTitle,
      sourceDetail,
      encodeTitle,
      encodeDetail,
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
  }, [encodeLadder, encoder, endpoints, mediaLabel, mediaSource, outputColors]);

  const loadBootstrapData = useCallback(async () => {
    setBootstrapping(true);
    setBootstrapError(null);

    try {
      await checkHealth();
      setApiOnline(true);

      const [protocolData, presetData, featureData] = await Promise.all([
        fetchProtocols(),
        fetchPresets(),
        fetchFeatures(readPublisherSession()).catch(() => ({
          local_publisher: false,
          local_publisher_connected: false,
          local_publisher_whip: false,
          local_publisher_agents: [],
        })),
      ]);

      setProtocols(protocolData.protocols);
      setPresets(presetData.presets);
      setFeatures(featureData);
      setEndpoints((current) => {
        const source =
          operatorPlan.encoder === "browser"
            ? "browser_moq"
            : (operatorPlan.source ?? "dummy");
        const ctx: RecipeContext = {
          source,
          presets: presetData.presets,
          caps: {
            safari: isSafariBrowser(),
            webTransport: detectBrowserMoqCapabilities().webTransport,
            rtcPeerConnection: detectBrowserMoqCapabilities().rtcPeerConnection,
          },
          publisher: { localFfmpegWhip: Boolean(featureData.local_publisher_whip) },
          encoder:
            operatorPlan.encoder ??
            (source === "browser_moq" ? "browser" : "ffmpeg"),
        };
        if (operatorPlan.outputs.length > 0) {
          return coerceRecipe(operatorEndpoints(operatorPlan.outputs, createEndpointId), ctx);
        }
        const seed = current.length > 0 ? current : buildDefaultEndpoints(ctx);
        return coerceRecipe(seed, ctx);
      });
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

  useEffect(() => {
    if (publisherSession) {
      return;
    }
    let cancelled = false;
    void mintPublisherSession()
      .then((minted) => {
        if (cancelled || !minted.session_id) {
          return;
        }
        writePublisherSession(minted.session_id);
        setPublisherSession(minted.session_id);
      })
      .catch(() => {
        /* API offline — helper command waits until mint succeeds */
      });
    return () => {
      cancelled = true;
    };
  }, [publisherSession]);

  // Poll agent connection whenever the API is up (local publish may be enabled).
  useEffect(() => {
    if (!apiOnline) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchFeatures(publisherSession);
        if (!cancelled) {
          setFeatures(next);
          if (!next.local_publisher && (isLocalAgentSource(mediaSource) || encoder === "obs")) {
            setEncoder("ffmpeg");
            if (isLocalAgentSource(mediaSource)) {
              setMediaSource("dummy");
              setMediaPath("dummy.mp4");
              setMediaLabel("Default Color Bars");
            }
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
  }, [apiOnline, mediaSource, encoder, publisherSession]);

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

  function handleEncoderChange(next: EncoderId) {
    if (next === encoder && !(next === "browser" && mediaSource !== "browser_moq")) {
      return;
    }
    if (next !== "ffmpeg" && next !== "obs" && next !== "browser") {
      return;
    }
    if ((next === "obs" || next === "browser") && mediaSource !== "webcam" && mediaSource !== "browser_moq") {
      return;
    }
    if (activePresetId === "protocol-compare" || activePresetId === "cloud-compare") {
      const nextSource = next === "browser" ? "browser_moq" : mediaSource === "browser_moq" ? "webcam" : mediaSource;
      setEncoder(next);
      if (next === "browser") {
        setMediaSource("browser_moq");
        setMediaLabel("Browser camera");
        setMediaPath(DEVICE_BROWSER_MEDIA);
        setComputeVmaf(false);
      } else if (mediaSource === "browser_moq") {
        setMediaSource("webcam");
        setMediaLabel("Webcam");
        setMediaPath(lastMileWebcamMediaPath());
      }
      const plan = applyBenchmarkPreset(
        activePresetId,
        { ...recipeContext, source: nextSource, encoder: next },
        createEndpointId,
        {
          currentEndpoints: endpoints,
          source: nextSource,
          encoder: next,
          protocol: activePresetId === "cloud-compare" ? sharedOutputProtocol(endpoints) : undefined,
        },
      );
      setEndpoints(plan.endpoints);
      return;
    }
    if (activePresetId && activePresetId !== "build-your-own") {
      setActivePresetId("build-your-own");
    }
    if (next === "browser") {
      setEncoder("browser");
      setMediaSource("browser_moq");
      setMediaLabel("Browser camera");
      setMediaPath(DEVICE_BROWSER_MEDIA);
      setComputeVmaf(false);
      setEndpoints((current) =>
        coerceRecipe(current, { ...recipeContext, source: "browser_moq", encoder: "browser" }),
      );
      return;
    }
    if (mediaSource === "browser_moq") {
      setMediaSource("webcam");
      setMediaLabel("Webcam");
      setMediaPath(lastMileWebcamMediaPath());
    }
    setEncoder(next);
    if (next === "ffmpeg" && mediaPath === OBS_OPENMOQ_MEDIA) {
      setMediaPath(lastMileWebcamMediaPath());
      setMediaLabel("Webcam");
    }
    if (next === "obs") {
      setEndpoints((current) => {
        const ctx = { ...recipeContext, source: "webcam" as const, encoder: "obs" as const };
        const coerced = coerceRecipe(current, ctx);
        if (coerced.some((endpoint) => endpoint.protocol === "moq")) {
          return coerced;
        }
        const moq = nextAddableEndpoint(coerced, ctx, ["moq"]);
        return moq ? [...coerced, { ...moq, id: createEndpointId() }] : coerced;
      });
    }
  }

  function handleMediaSourceChange(next: MediaSourceId) {
    setMediaSource(next);
    setWebcamStatus(null);
    let nextEncoder: EncoderId = encoder;
    if (next === "browser_moq") {
      nextEncoder = "browser";
    } else if (next === "webcam") {
      if (encoder === "browser") {
        nextEncoder = "ffmpeg";
      }
    } else if (encoder === "obs" || encoder === "browser") {
      nextEncoder = "ffmpeg";
    }
    if (activePresetId === "cloud-compare") {
      const nextSource = next;
      const nextEnc: EncoderId =
        nextSource === "browser_moq"
          ? "browser"
          : nextSource === "webcam"
            ? encoder === "browser"
              ? "ffmpeg"
              : encoder
            : "ffmpeg";
      if (nextSource === "dummy") {
        setMediaPath("dummy.mp4");
        setMediaLabel("Default Color Bars");
      } else if (nextSource === "bbb") {
        setMediaPath(BBB_MEDIA_PATH);
        setMediaLabel("Big Buck Bunny");
      } else if (nextSource === "upload") {
        setMediaPath("");
        setMediaLabel("Choose a local file");
        setComputeVmaf(false);
      } else if (nextSource === "webcam") {
        setMediaLabel("Webcam");
        setMediaPath(lastMileWebcamMediaPath());
        setComputeVmaf(false);
      } else if (nextSource === "browser_moq") {
        setMediaLabel("Browser camera");
        setMediaPath(DEVICE_BROWSER_MEDIA);
        setComputeVmaf(false);
      }
      setEncoder(nextEnc);
      const plan = applyBenchmarkPreset(
        "cloud-compare",
        { ...recipeContext, source: nextSource, encoder: nextEnc },
        createEndpointId,
        {
          currentEndpoints: endpoints,
          source: nextSource,
          encoder: nextEnc,
          protocol: sharedOutputProtocol(endpoints),
        },
      );
      setEndpoints(plan.endpoints);
      return;
    }
    if (activePresetId === "contribution-compare") {
      const nextSource = next === "browser_moq" ? "webcam" : next;
      if (nextSource !== next) {
        setMediaSource(nextSource);
      }
      setEncoder("ffmpeg");
      if (nextSource === "dummy") {
        setMediaPath("dummy.mp4");
        setMediaLabel("Default Color Bars");
      } else if (nextSource === "bbb") {
        setMediaPath(BBB_MEDIA_PATH);
        setMediaLabel("Big Buck Bunny");
      } else if (nextSource === "upload") {
        setMediaPath("");
        setMediaLabel("Choose a local file");
        setComputeVmaf(false);
      } else {
        setMediaLabel("Webcam");
        setMediaPath(lastMileWebcamMediaPath());
        setComputeVmaf(false);
      }
      const plan = applyBenchmarkPreset(
        "contribution-compare",
        { ...recipeContext, source: nextSource, encoder: "ffmpeg" },
        createEndpointId,
        { currentEndpoints: endpoints, source: nextSource, encoder: "ffmpeg" },
      );
      setEndpoints(plan.endpoints);
      return;
    }
    if (activePresetId === "protocol-compare") {
      if (next !== "webcam" && next !== "browser_moq" && (encoder === "obs" || encoder === "browser")) {
        setEncoder("ffmpeg");
      }
      if (next === "webcam" && encoder === "browser") {
        setEncoder("ffmpeg");
      }
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
        setMediaLabel("Browser camera");
        setMediaPath(DEVICE_BROWSER_MEDIA);
        setComputeVmaf(false);
        setEncoder("browser");
      }
      const plan = applyBenchmarkPreset(
        "protocol-compare",
        { ...recipeContext, source: next, encoder: nextEncoder },
        createEndpointId,
        { currentEndpoints: endpoints, source: next, encoder: nextEncoder },
      );
      setEndpoints(plan.endpoints);
      return;
    }
    if (activePresetId && activePresetId !== "build-your-own") {
      setActivePresetId("build-your-own");
    }
    if (next !== "webcam" && next !== "browser_moq" && (encoder === "obs" || encoder === "browser")) {
      setEncoder("ffmpeg");
    }
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
      if (encoder === "browser") {
        setEncoder("ffmpeg");
      }
    } else if (next === "browser_moq") {
      setMediaLabel("Browser camera");
      setMediaPath(DEVICE_BROWSER_MEDIA);
      setComputeVmaf(false);
      setEncoder("browser");
      setEndpoints((current) =>
        coerceRecipe(current, { ...recipeContext, source: "browser_moq", encoder: "browser" }),
      );
    }
  }

  function handleBenchmarkPreset(id: BenchmarkPresetId) {
    if (id === "build-your-own") {
      setActivePresetId(id);
      setSetupCursor(firstStepAfterRecipe(setupStepsForRecipe(setupFlagsForPreset(id))));
      return;
    }
    const plan = applyBenchmarkPreset(id, recipeContext, createEndpointId, {
      currentEndpoints: endpoints,
      source: recipeContext.source,
      encoder: recipeContext.encoder,
    });
    setActivePresetId(id);
    setSetupCursor(firstStepAfterRecipe(setupStepsForRecipe(setupFlagsForPreset(id))));
    setTestScope(plan.testScope);
    setWebcamStatus(null);
    setEncoder(plan.encoder);
    setMediaSource(plan.source);
    if (plan.source === "dummy") {
      setMediaPath("dummy.mp4");
      setMediaLabel("Default Color Bars");
    } else if (plan.source === "bbb") {
      setMediaPath(BBB_MEDIA_PATH);
      setMediaLabel("Big Buck Bunny");
    } else if (plan.source === "upload") {
      setMediaPath("");
      setMediaLabel("Choose a local file");
      setComputeVmaf(false);
    } else if (plan.source === "webcam") {
      setMediaPath(lastMileWebcamMediaPath());
      setMediaLabel("Webcam");
      setComputeVmaf(false);
    } else if (plan.source === "browser_moq") {
      setMediaPath(DEVICE_BROWSER_MEDIA);
      setMediaLabel("Browser camera");
      setComputeVmaf(false);
    }
    setEndpoints(plan.endpoints);
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
    setEndpoints((current) => {
      if (current.length === 0) {
        return current;
      }
      return coerceRecipe(current, recipeContext);
    });
  }, [recipeContext]);

  useEffect(() => {
    if (!apiOnline || presets.length === 0) {
      return;
    }

    setEndpoints((current) => {
      let changed = false;
      const next = current.map((endpoint) => {
        if (endpoint.protocol !== "moq" || !endpoint.ingestEndpointId.includes("_moq_relay")) {
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
          "Picture-quality scoring is not available on this host right now.",
      );
      return;
    }
    if (isLocalAgentSource(mediaSource)) {
      setVmafUnavailableReason(
        encoderVmafAvailable
          ? "Scores the file after encode. WebRTC is not scored."
          : "This laptop cannot score picture quality yet.",
      );
      return;
    }
    if (mediaSource === "browser_moq") {
      setVmafUnavailableReason(
        anyIngestVmafAvailable
          ? "MoQ can be scored after the relay. WebRTC is not scored."
          : "Picture-quality scoring is not available for this Browser path.",
      );
      return;
    }
    if (!vmafBothAvailable) {
      setVmafUnavailableReason(
        encoderVmafAvailable
          ? "The encode can be scored. Some destinations cannot record a second score."
          : "Encode scoring is unavailable — destination scores may still run.",
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
    if (tab !== "metrics" || sessionMetrics.length > 0 || loading) {
      return;
    }
    let cancelled = false;
    void fetchResults()
      .then(async ({ results }) => {
        if (cancelled || results.length === 0) {
          return;
        }
        const newest = [...results].sort((a, b) =>
          String(b.modified_at || "").localeCompare(String(a.modified_at || "")),
        )[0];
        if (!newest) {
          return;
        }
        const detail = await fetchResultDetail(newest.filename);
        if (cancelled) {
          return;
        }
        setSessionMetrics([detail]);
        setSessionMetricLabels([detail.summary_extra?.stream_label || newest.filename]);
        setSelectedSessionKey(`single:${newest.filename}`);
        setSessionFromHistory(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, sessionMetrics.length, loading]);

  function updateEndpoint(id: string, patch: Partial<EndpointConfig>) {
    setEndpoints((current) =>
      coerceRecipe(
        current.map((endpoint) =>
          endpoint.id === id ? applyEndpointPatch(endpoint, patch) : endpoint,
        ),
        recipeContext,
      ),
    );
  }

  function handleCloudProtocolChange(protocol: PublishProtocolId) {
    if (activePresetId !== "cloud-compare") {
      return;
    }
    let source = recipeContext.source;
    let nextEncoder = recipeContext.encoder ?? "ffmpeg";
    if (
      (protocol === "srt" || protocol === "rtmp") &&
      (nextEncoder === "browser" || source === "browser_moq")
    ) {
      nextEncoder = "ffmpeg";
      if (source === "browser_moq") {
        source = "webcam";
        setMediaSource("webcam");
        setMediaLabel("Webcam");
        setMediaPath(lastMileWebcamMediaPath());
      }
      setEncoder("ffmpeg");
    }
    const plan = applyBenchmarkPreset(
      "cloud-compare",
      { ...recipeContext, source, encoder: nextEncoder },
      createEndpointId,
      {
        currentEndpoints: endpoints,
        source,
        encoder: nextEncoder,
        protocol,
      },
    );
    setEndpoints(plan.endpoints);
  }

  function addEndpoint() {
    if (activePresetId && activePresetId !== "build-your-own" && activePresetId !== "cloud-compare") {
      setActivePresetId("build-your-own");
    }
    setEndpoints((current) => {
      if (current.length >= MAX_ENDPOINTS) {
        return current;
      }
      const mix = recipeLocksProtocolMix(activePresetId) ? sharedOutputProtocol(current) : undefined;
      const next = nextAddableEndpoint(current, recipeContext, mix ? [mix] : undefined);
      if (!next) {
        return current;
      }
      return coerceRecipe([...current, { ...next, id: createEndpointId() }], recipeContext);
    });
  }

  function removeEndpoint(id: string) {
    if (activePresetId && activePresetId !== "build-your-own" && activePresetId !== "cloud-compare") {
      setActivePresetId("build-your-own");
    }
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
    playback_policy?: PlaybackPolicy;
    test_scope?: TestScope;
    comparison_id: string;
    stream_index: number;
    stream_label: string;
    preset_id?: string;
    protocol?: string;
    endpoint_url?: string;
    publisher_host?: "cloud" | "local" | "browser";
    encoder?: "ffmpeg" | "obs";
    publisher_session?: string;
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
      playback_policy: playbackPolicy,
      test_scope: testScope,
      comparison_id: comparisonId,
      stream_index: streamIndex,
      stream_label: endpointLabel(endpoint, streamIndex, presets),
      publisher_host:
        publisherHost === "browser"
          ? "browser"
          : features.local_publisher
            ? publisherHost
            : "cloud",
      encoder: encoder === "obs" ? "obs" : "ffmpeg",
      ...(publisherSession ? { publisher_session: publisherSession } : {}),
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
                  samples: [
                    ...leg.samples,
                    mergeEncoderSampleWithLivePlayback(
                      sample,
                      leg.latestSample ?? leg.samples.at(-1),
                    ),
                  ],
                  latestSample: mergeEncoderSampleWithLivePlayback(
                    sample,
                    leg.latestSample ?? leg.samples.at(-1),
                  ),
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
              waiting_for_encode_slot:
                status.waiting_for_encode_slot ?? leg.job.waiting_for_encode_slot,
              encode_queue_ahead: status.encode_queue_ahead ?? leg.job.encode_queue_ahead,
              encode_slot_limit: status.encode_slot_limit ?? leg.job.encode_slot_limit,
              csv_path: status.csv_path ?? leg.job.csv_path,
              summary_path: status.summary_path ?? leg.job.summary_path,
              error: status.error,
              cancelled: status.cancelled ?? leg.job.cancelled,
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
            // Do not wait for VMAF — testers open Results as soon as encode ends.
            void loadSessionMetricsFromLegs(next);
          }
          if (
            allEncoded &&
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
      // csv_path can be a laptop path the API cannot serve. Fall back to
      // the newest listed results so the Results tab is not blank.
      try {
        const { results } = await fetchResults();
        const newest = [...results]
          .sort((a, b) => String(b.modified_at || "").localeCompare(String(a.modified_at || "")))
          .slice(0, Math.max(1, legs.length));
        if (newest.length === 0) {
          return;
        }
        const details = await Promise.all(newest.map((file) => fetchResultDetail(file.filename)));
        setSessionMetrics(details);
        setSessionMetricLabels(newest.map((file, index) => legs[index]?.label || file.filename));
        setSelectedSessionKey(`single:${newest[0].filename}`);
        setSessionFromHistory(false);
        setSessionHistoryRefreshToken((token) => token + 1);
      } catch {
        // Empty Results state still explains how to load history.
      }
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
    try {
      const { results } = await fetchResults();
      const newest = [...results]
        .sort((a, b) => String(b.modified_at || "").localeCompare(String(a.modified_at || "")))
        .slice(0, Math.max(1, legs.length));
      if (newest.length === 0) {
        return;
      }
      const details = await Promise.all(newest.map((file) => fetchResultDetail(file.filename)));
      setSessionMetrics(details);
      setSessionMetricLabels(newest.map((file, index) => legs[index]?.label || file.filename));
      setSelectedSessionKey(`single:${newest[0].filename}`);
      setSessionFromHistory(true);
      setSessionHistoryRefreshToken((token) => token + 1);
    } catch {
      // Empty Results state still explains how to load history.
    }
  }

  async function handleStart() {
    setError(null);
    setComparisonLegs([]);
    comparisonFinishedRef.current = false;
    comparisonJobIdsRef.current = [];
    stopRequestedRef.current = false;
    setSessionMetrics([]);
    setSessionMetricLabels([]);
    setSelectedSessionKey(null);
    setSessionFromHistory(false);
    setLoading(true);

    const startEndpoints = coerceRecipe(endpoints, recipeContext);
    if (startEndpoints !== endpoints) {
      setEndpoints(startEndpoints);
    }

    const blocked = recipeIssue(startEndpoints, recipeContext);
    if (blocked) {
      setError(blocked);
      setLoading(false);
      return;
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

    if (encoder === "obs") {
      if (!features.local_publisher) {
        setError("OBS encode requires the local publisher agent, which is not enabled on this deployment.");
        setLoading(false);
        return;
      }
      if (!features.local_publisher_connected) {
        setError(
          "No local publisher agent connected. Run the helper command, then retry.",
        );
        setLoading(false);
        return;
      }
      if (!startEndpoints.some((endpoint) => endpoint.protocol === "moq")) {
        setError(
          "OBS needs a MoQ output — the plugin occupies Settings → Stream. Add SRT/RTMP alongside it.",
        );
        setLoading(false);
        return;
      }
    } else if (isLocalAgentSource(mediaSource)) {
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

      if (encoder === "obs") {
        setWebcamStatus(
          `OBS will encode (MoQ plugin + SRT/RTMP) — press Stop when finished (auto-stops at ${LIVE_WEBCAM_MAX_DURATION_SEC / 60} min).`,
        );
        mediaPaths = startEndpoints.map(() => OBS_OPENMOQ_MEDIA);
        durationSec = LIVE_WEBCAM_MAX_DURATION_SEC;
        setMediaPath(OBS_OPENMOQ_MEDIA);
      } else if (isLocalAgentSource(mediaSource)) {
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
        // Bundled VOD is clipped to 60s (BBB is ~10 min on disk). Uploads
        // omit duration and let the API probe + cap at 5 minutes.
        mediaPaths = startEndpoints.map(() => mediaPath);
        durationSec =
          mediaSource === "dummy" || mediaSource === "bbb" ? CLOUD_PLAYOUT_DURATION_SEC : undefined;
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
      comparisonJobIdsRef.current = jobs.map((job) => job.id);
      if (stopRequestedRef.current) {
        await Promise.all(jobs.map((job) => stopUpload(job.id).catch(() => undefined)));
        setLoading(false);
        setWebcamStatus("Stopped before encode started.");
        return;
      }

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
              const pinTls = moqPinTlsCertForIngest(endpoint.ingestEndpointId);
              return {
                jobId: job.id,
                protocol: "moq" as const,
                relayUrl,
                namespace: job.moq_namespace || `bench-${job.id.replace(/-/g, "").slice(0, 8)}`,
                fingerprintUrl: pinTls
                  ? endpoint.moqFingerprintUrl?.trim() || proxiedMoqFingerprintUrl(relayUrl)
                  : undefined,
                ingestVmaf: Boolean(computeVmaf && endpoint.vmafAvailable),
                draftVersion: moqDraftForIngest(endpoint.ingestEndpointId),
              };
            }),
          });
          browserMoqRunRef.current = run;
          setBrowserPreviewStream(run.previewStream);
          setBrowserHasAudio(run.hasAudio);
          setBrowserVideoCodec(run.videoCodec || "");
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
        if (stopRequestedRef.current) {
          stopBrowserMoqRun();
          await Promise.all(jobs.map((job) => stopUpload(job.id).catch(() => undefined)));
          setLoading(false);
          setWebcamStatus("Stopped before encode started.");
          return;
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
          isLive:
            encoder === "obs" ||
            isLocalAgentSource(mediaSource) ||
            mediaSource === "browser_moq",
          isBrowserSource: mediaSource === "browser_moq",
        }),
        encoderVmafRequested: wantsEncoderVmaf({
          computeVmaf,
          encoderVmafAvailable,
          protocol: startEndpoints[index].protocol,
          isLive:
            encoder === "obs" ||
            isLocalAgentSource(mediaSource) ||
            mediaSource === "browser_moq",
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
        if (encoder === "obs") {
          setWebcamStatus("OBS run finished.");
        } else if (isLocalAgentSource(mediaSource)) {
          setWebcamStatus("Live webcam run finished.");
        } else if (mediaSource === "browser_moq") {
          // Keep the camera publishing through the player drain window.
          // Stopping on the job-complete tick left the relay idle while the
          // player still thought it was live — 4 leftover LOC frames, then
          // three RESET_STREAM reconnects (demo 2026-08-18).
          const run = browserMoqRunRef.current;
          window.setTimeout(() => {
            if (browserMoqRunRef.current !== run) {
              return;
            }
            stopBrowserMoqRun();
            setWebcamStatus("Browser run finished.");
          }, PLAYBACK_DRAIN_MS);
          setWebcamStatus("Browser encode finished — draining playback…");
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
    stopRequestedRef.current = true;
    comparisonFinishedRef.current = true;
    stopBrowserMoqRun();
    setComparisonLegs((current) =>
      current.map((leg) => ({
        ...leg,
        job: { ...leg.job, cancelled: true },
      })),
    );
    setWebcamStatus(
      encoder === "obs"
        ? "Stopping OBS outputs…"
        : mediaSource === "webcam"
        ? "Stopping live webcam and encoders…"
        : mediaSource === "browser_moq"
          ? "Stopping in-browser MoQ publisher…"
          : "Stopping comparison…",
    );
    pushToast("Stopping comparison…", "info");
    const ids = comparisonJobIdsRef.current.length
      ? comparisonJobIdsRef.current
      : comparisonLegs.map((leg) => leg.id);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          await stopUpload(id);
          return { ok: true as const };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return { ok: true as const };
          }
          return { ok: false as const, message };
        }
      }),
    );
    setLoading(false);
    const failed = results.filter((item) => !item.ok);
    if (failed.length) {
      pushToast(failed[0].message || "Stop failed", "error");
      return;
    }
    pushToast(ids.length ? "Comparison stopped" : "Stopped", "success");
  }

  const safariUnsupported = recipeCaps.safari;
  const sharedProtocol = sharedOutputProtocol(endpoints);
  const canAddOutput = canAddRecipeOutput(
    endpoints,
    recipeContext,
    MAX_ENDPOINTS,
    recipeLocksProtocolMix(activePresetId) && sharedProtocol ? [sharedProtocol] : undefined,
  );
  const recipePicked = activePresetId !== null;
  const showTestScope = wizardStepVisible(activePresetId, "testScope");
  const showSourceMode = wizardStepVisible(activePresetId, "source");
  const showSourceOps =
    recipePicked &&
    (showSourceMode || isLocalAgentSource(mediaSource) || mediaSource === "browser_moq");
  const showEncoderPicker = wizardStepVisible(activePresetId, "encoder");
  const showSharedProtocol = recipeShowsSharedProtocolPicker(activePresetId);
  const showOutputConfig = wizardStepVisible(activePresetId, "outputs");
  const showEndpointPickers = recipeShowsEndpointPickers(activePresetId);
  const showOutputTiles = showOutputConfig || showEndpointPickers;
  const lockOutputProtocol = recipeLocksProtocolMix(activePresetId) || !showOutputConfig;
  const lockedRecipeSummary = recipeLockedSummary(activePresetId);
  const setupSteps = setupStepsForRecipe(setupFlagsForPreset(activePresetId));
  const runLayout = loading || comparisonLegs.length > 0;
  const recipeState = setupStepState(setupSteps, setupCursor, "recipe", runLayout);
  const testScopeState = setupStepState(setupSteps, setupCursor, "testScope", runLayout);
  const sourceState = setupStepState(setupSteps, setupCursor, "source", runLayout);
  const protocolState = setupStepState(setupSteps, setupCursor, "protocol", runLayout);
  const encodeState = setupStepState(setupSteps, setupCursor, "encode", runLayout);
  const outputsState = setupStepState(setupSteps, setupCursor, "outputs", runLayout);
  const showOutputsPane = outputsState === "current" || runLayout;
  const setupHasContinue = !isLastSetupStep(setupSteps, setupCursor);
  const sourceSummary =
    mediaSource === "webcam" || mediaSource === "browser_moq"
      ? mediaSource === "browser_moq"
        ? "Webcam · Browser"
        : "Webcam"
      : mediaSource === "bbb"
        ? "Cloud playout · Big Buck Bunny"
        : mediaSource === "upload"
          ? mediaPath
            ? `Cloud playout · ${mediaLabel}`
            : "Cloud playout · choose a file"
          : "Cloud playout · Color bars";
  const encodeSummary = [
    resolveEncodeLadder(encodeLadder).label.split("·")[0]?.trim() ?? encodeLadder,
    encoder === "browser" ? "Browser" : encoder === "obs" ? "OBS" : "ffmpeg",
    isUploadOnlyScope(testScope)
      ? null
      : playbackPolicy === PLAYBACK_POLICY_LIVE_EDGE
        ? "Live edge"
        : "Complete",
  ]
    .filter(Boolean)
    .join(" · ");
  const outputsSummary = endpoints
    .map((endpoint) => protocolLabel(endpoint.protocol))
    .join(" + ");
  function continueSetup() {
    const next = nextSetupStep(setupSteps, setupCursor);
    if (next) {
      setSetupCursor(next);
    }
  }
  function reopenSetup(step: SetupStepId) {
    setSetupCursor(step);
  }
  const cloudProtocolChoices = showSharedProtocol
    ? publishProtocolIdsForSource(
        recipeContext.source,
        recipeContext.caps,
        recipeContext.publisher,
        recipeContext.encoder ?? "ffmpeg",
      )
    : [];
  const wizardStep = { n: 0 };
  const allocWizardStep = (visible: boolean) => (visible ? (wizardStep.n += 1) : 0);
  const recipeStep = allocWizardStep(true);
  const testScopeStep = allocWizardStep(showTestScope);
  const sourceStep = allocWizardStep(showSourceMode);
  const protocolStep = allocWizardStep(showSharedProtocol);
  const encodeStep = allocWizardStep(recipePicked);
  const outputsStep = allocWizardStep(showOutputTiles);
  const liveMetricRanks = compareLiveMetrics(
    endpoints.map((endpoint, index) => {
      const sample = comparisonLegs[index]?.latestSample ?? null;
      if (!sample) {
        return { protocol: endpoint.protocol };
      }
      return { ...sample, protocol: endpoint.protocol };
    }),
  );
  const needsLocalHelper =
    encoder === "obs" || isLocalAgentSource(mediaSource);
  const helperConnected =
    Boolean(features.local_publisher) && Boolean(features.local_publisher_connected);
  const obsWebsocketUp = Boolean(features.local_publisher_obs?.websocket);
  const hasMoqOutput = endpoints.some((endpoint) => endpoint.protocol === "moq");
  const obsStartAllowed =
    encoder !== "obs" || (helperConnected && (obsWebsocketUp || hasMoqOutput));
  const obsWebsocketHint =
    encoder === "obs" && helperConnected && !obsWebsocketUp
      ? features.local_publisher_obs?.detail?.trim() ||
        "OBS WebSocket is not connected on ws://127.0.0.1:4455. Enable Tools → WebSocket Server. Start will still dispatch the MoQ job — press Start Stream in OBS if the helper cannot reach it."
      : undefined;
  const startTitle = recipeBlockReason
    ? recipeBlockReason
    : !apiOnline
      ? "API is offline."
      : endpoints.length < minEndpointsForSource(mediaSource)
        ? "Add at least one output."
        : mediaSource === "bbb" && !bbbAvailable
          ? bbbSource?.hint ?? "Big Buck Bunny is not on this host yet."
          : mediaSource === "upload" && !mediaPath
            ? "Choose a file to encode."
            : needsLocalHelper && !helperConnected
              ? "No local publisher agent connected. Run the helper command, then retry."
              : encoder === "obs" && !obsStartAllowed
                ? obsWebsocketHint ||
                  "OBS encode needs the helper and a MoQ output. Enable Tools → WebSocket Server."
                : mediaSource === "browser_moq" && !browserSourceCanStart(endpoints)
                  ? "This browser cannot publish the selected outputs yet."
                  : undefined;
  const startHint = startTitle || obsWebsocketHint;
  const startDisabled =
    loading ||
    bootstrapping ||
    uploadingMedia ||
    Boolean(startTitle);
  const startLabel = uploadingMedia ? "Preparing…" : loading ? "Running…" : "Start";

  function renderStartStop(extraClass = "", options: { start?: boolean } = {}) {
    const showStart = options.start !== false;
    return (
      <>
        {showStart && (
        <button
          className={`primary${extraClass ? ` ${extraClass}` : ""}`}
          onClick={() => void handleStart()}
          title={startTitle}
          disabled={startDisabled}
        >
          {startLabel}
        </button>
        )}
        {loading && (
          <button
            className="secondary-button stop-webcam-button"
            onClick={() => void handleStopComparison()}
          >
            Stop
          </button>
        )}
      </>
    );
  }

  return (
    <div className="app">
      {safariUnsupported && (
        <div className="info-banner safari-banner" role="status">
          Safari playback is not supported. Use Chrome or Edge.
        </div>
      )}
      <header className="hero">
        <div className="hero-brand">
          <span className="hero-mark" aria-hidden="true">
            <IconBroadcast size={20} />
          </span>
          <div>
            <h1>MoQ Bench</h1>
          </div>
        </div>
        <div className="hero-right">
          <StatusDot
            tone={bootstrapping ? "idle" : apiOnline ? "ok" : "bad"}
            label={bootstrapping ? "Connecting…" : apiOnline ? "API online" : "API offline"}
            className="hero-api-status"
          />
          {tab === "benchmark" && (recipePicked || loading) && (
            <div className="hero-start-row" aria-label="Run controls">
              {renderStartStop("hero-start-button", { start: recipePicked })}
            </div>
          )}
          <a className="hero-support" href={PAYPAL_DONATE_URL} target="_blank" rel="noreferrer">
            Support
          </a>
          <nav className="tabs">
            <button className={tab === "benchmark" ? "active" : ""} onClick={() => setTab("benchmark")}>
              Benchmark
            </button>
            <button
              className={tab === "metrics" ? "active" : ""}
              onClick={() => setTab("metrics")}
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

      <main>
        {tab === "benchmark" && (
          <div className="benchmark-page">
          <div className={runLayout ? "benchmark-split" : undefined}>
            <div className={runLayout ? "benchmark-split-setup" : undefined}>
            <section className="panel benchmark-shared">
              <div className="benchmark-shared-stack">
                <SetupStepFrame
                  step="recipe"
                  index={recipeStep}
                  state={recipeState}
                  title="Recipe"
                  summary={recipeDef(activePresetId)?.label ?? "Choose a recipe"}
                  onReopen={() => reopenSetup("recipe")}
                >
                <section className="recipe-section">
                  <StepHeading
                    step={recipeStep}
                    title="Recipe"
                    tip="Pick a precanned experiment or build your own. Precanned recipes default tiles and hide the steps they already decided."
                  />
                  <div className="source-mode-options recipe-options" role="radiogroup" aria-label="Harness recipes">
                    {BENCHMARK_PRESET_DEFS.map((preset) => (
                      <label
                        key={preset.id}
                        className={`source-mode-card${preset.id === "build-your-own" ? " recipe-card-custom" : ""}${activePresetId === preset.id ? " selected" : ""}`}
                      >
                        <input
                          type="radio"
                          name="harness-recipe"
                          checked={activePresetId === preset.id}
                          disabled={bootstrapping || !apiOnline || loading}
                          onChange={() => handleBenchmarkPreset(preset.id)}
                        />
                        <span className="source-mode-card-body">
                          <strong>{preset.label}</strong>
                          <span className="source-mode-card-hint">{preset.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {lockedRecipeSummary ? (
                    <p className="field-hint recipe-locked-summary">{lockedRecipeSummary}</p>
                  ) : !recipePicked ? (
                    <p className="field-hint">Choose a recipe to continue the wizard.</p>
                  ) : null}
                </section>
                </SetupStepFrame>
                <SetupStepFrame
                  step="testScope"
                  index={testScopeStep}
                  state={testScopeState}
                  title="Test"
                  summary={testScope === TEST_SCOPE_UPLOAD ? "Upload only" : "End-to-end"}
                  onReopen={() => reopenSetup("testScope")}
                  onContinue={setupHasContinue ? continueSetup : undefined}
                >
                <section className="test-scope-section">
                  <StepHeading
                    step={testScopeStep}
                    title="Test"
                    tip="Choose what this run measures. Upload-only stops at ingest — no glass tiles."
                  />
                  <div className="encode-location-options playback-policy-options" role="radiogroup" aria-label="Test scope">
                    <label className={`source-mode-card${testScope === TEST_SCOPE_E2E ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="test-scope"
                        checked={testScope === TEST_SCOPE_E2E}
                        disabled={bootstrapping || !apiOnline || loading}
                        onChange={() => setTestScope(TEST_SCOPE_E2E)}
                      />
                      <span className="source-mode-card-body">
                        <strong>End-to-end</strong>
                        <span className="source-mode-card-hint">{TEST_SCOPE_E2E_COPY}</span>
                      </span>
                    </label>
                    <label className={`source-mode-card${testScope === TEST_SCOPE_UPLOAD ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="test-scope"
                        checked={testScope === TEST_SCOPE_UPLOAD}
                        disabled={bootstrapping || !apiOnline || loading}
                        onChange={() => setTestScope(TEST_SCOPE_UPLOAD)}
                      />
                      <span className="source-mode-card-body">
                        <strong>Upload only</strong>
                        <span className="source-mode-card-hint">{TEST_SCOPE_UPLOAD_COPY}</span>
                      </span>
                    </label>
                  </div>
                  <p className="field-hint">{testScopeBanner(testScope)}</p>
                </section>
                </SetupStepFrame>
                <SetupStepFrame
                  step="source"
                  index={sourceStep}
                  state={sourceState}
                  title="Source"
                  summary={sourceSummary}
                  onReopen={() => reopenSetup("source")}
                  onContinue={setupHasContinue ? continueSetup : undefined}
                >
                {showSourceOps ? (
                <SourceSection
                  mediaSource={mediaSource}
                  onMediaSourceChange={handleMediaSourceChange}
                  mediaPath={mediaPath}
                  mediaLabel={mediaLabel}
                  uploadingMedia={uploadingMedia}
                  onUploadFile={handleUploadFile}
                  encoder={encoder}
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
                  preferD18Helper={endpoints.some((endpoint) =>
                    endpoint.ingestEndpointId.includes("moq_relay_d18"),
                  )}
                  step={sourceStep}
                  hideModePicker={!showSourceMode}
                  publisherSession={publisherSession}
                />
                ) : null}
                </SetupStepFrame>

                <SetupStepFrame
                  step="protocol"
                  index={protocolStep}
                  state={protocolState}
                  title="Protocol"
                  summary={sharedProtocol ? cloudCompareProtocolLabel(sharedProtocol) : "Choose a protocol"}
                  onReopen={() => reopenSetup("protocol")}
                  onContinue={setupHasContinue ? continueSetup : undefined}
                >
                <section className="cloud-protocol-section">
                  <StepHeading
                    step={protocolStep}
                    title="Protocol"
                    tip="Same publish protocol on every cloud tile. Mixed-protocol 4-way lives in Capture to glass."
                  />
                  <div className="source-mode-options" role="radiogroup" aria-label="Cloud compare protocol">
                    {cloudProtocolChoices.map((protocol) => (
                      <label
                        key={protocol}
                        className={`source-mode-card${sharedProtocol === protocol ? " selected" : ""}`}
                      >
                        <input
                          type="radio"
                          name="cloud-compare-protocol"
                          checked={sharedProtocol === protocol}
                          disabled={bootstrapping || !apiOnline || loading}
                          onChange={() => handleCloudProtocolChange(protocol)}
                        />
                        <span className="source-mode-card-body">
                          <strong>{cloudCompareProtocolLabel(protocol)}</strong>
                          <span className="source-mode-card-hint">{cloudCompareProtocolHint(protocol)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
                </SetupStepFrame>

                <SetupStepFrame
                  step="encode"
                  index={encodeStep}
                  state={encodeState}
                  title="Encode"
                  summary={encodeSummary}
                  onReopen={() => reopenSetup("encode")}
                  onContinue={setupHasContinue ? continueSetup : undefined}
                >
                <section className="encoder-profile-section">
                  <StepHeading
                    step={encodeStep}
                    title="Encode"
                    tip="Same ladder for every output. HLS/SRT stay on a 2s floor; MoQ uses a 400 ms budget. Last-mile Webcam picks ffmpeg (default), OBS, or Browser. ffmpeg opens the camera on the computer running the helper."
                  />
                  <div className="encoder-profile-body">
                    {showEncoderPicker && (mediaSource === "webcam" || mediaSource === "browser_moq") ? (
                      <div className="encode-encoder-picker">
                        <div
                          className="source-mode-options encode-encoder-options"
                          role="radiogroup"
                          aria-label="Last-mile encoder"
                        >
                          <label className={`source-mode-card${encoder === "ffmpeg" ? " selected" : ""}`}>
                            <input
                              type="radio"
                              name="encode-encoder"
                              checked={encoder === "ffmpeg"}
                              disabled={bootstrapping || !apiOnline || loading}
                              onChange={() => handleEncoderChange("ffmpeg")}
                            />
                            <span className="source-mode-card-body">
                              <strong>
                                <IconBroadcast size={15} /> ffmpeg
                              </strong>
                              <span className="source-mode-card-hint">
                                Default · helper encodes SRT, RTMP, WebRTC, MoQ
                              </span>
                            </span>
                          </label>
                          <label
                            className={`source-mode-card${encoder === "obs" ? " selected" : ""}`}
                            title={
                              obsEncoderSupported
                                ? undefined
                                : "OBS OpenMOQ plugin is draft-16 only. Public MoQ is draft-18. Use ffmpeg."
                            }
                          >
                            <input
                              type="radio"
                              name="encode-encoder"
                              checked={encoder === "obs"}
                              disabled={
                                bootstrapping ||
                                !apiOnline ||
                                loading ||
                                !obsEncoderSupported
                              }
                              onChange={() => handleEncoderChange("obs")}
                            />
                            <span className="source-mode-card-body">
                              <strong>
                                <IconMonitor size={15} /> OBS
                              </strong>
                              <span className="source-mode-card-hint">
                                {obsEncoderSupported
                                  ? "Option · OBS encodes; plugin does MoQ"
                                  : "Unavailable · plugin is draft-16 only"}
                              </span>
                            </span>
                          </label>
                          {(activePresetId !== "cloud-compare" ||
                            sharedProtocol === "moq" ||
                            sharedProtocol === "webrtc") && (
                          <label className={`source-mode-card${encoder === "browser" ? " selected" : ""}`}>
                            <input
                              type="radio"
                              name="encode-encoder"
                              checked={encoder === "browser"}
                              disabled={bootstrapping || !apiOnline || loading}
                              onChange={() => handleEncoderChange("browser")}
                            />
                            <span className="source-mode-card-body">
                              <strong>
                                <IconCpu size={15} /> Browser
                              </strong>
                              <span className="source-mode-card-hint">
                                This tab · MoQ + WebRTC only
                              </span>
                            </span>
                          </label>
                          )}
                        </div>
                        <p className="source-mode-explainer">{encoderModeExplainer(encoder)}</p>
                        {encoder === "obs" && (
                          <p className="field-hint">
                            {obsEncoderSupported ? (
                              <>
                                Enable Tools → WebSocket Server. Load{" "}
                                <code>tools/obs/benchmark-outputs.lua</code> in OBS → Tools →
                                Scripts for SRT/RTMP alongside MoQ.
                                {features.local_publisher_obs?.websocket
                                  ? features.local_publisher_obs.plugin
                                    ? " WebSocket connected."
                                    : ` ${features.local_publisher_obs.detail || "WebSocket is up. Plugin not found on disk — Start still works if OBS already loaded it."}`
                                  : features.local_publisher_connected
                                    ? ` ${features.local_publisher_obs?.detail || "OBS WebSocket not connected on ws://127.0.0.1:4455. Set OBS_WEBSOCKET_PASSWORD, enable Tools → WebSocket Server, and load tools/obs/benchmark-outputs.lua."}`
                                    : " Start the helper app first — it talks to OBS at ws://127.0.0.1:4455."}
                              </>
                            ) : (
                              recipeBlockReason ||
                              "OBS OpenMOQ plugin is draft-16 only. Public MoQ is draft-18 (:14433). Use ffmpeg (helper) for MoQ."
                            )}
                          </p>
                        )}
                      </div>
                    ) : showEncoderPicker ? (
                      <p className="field-hint encode-encoder-locked">
                        Server ffmpeg encodes this file. ffmpeg (helper), OBS, and Browser are
                        last-mile options under Webcam — ffmpeg stays the default there.
                      </p>
                    ) : null}
                    <div className="encode-profile-grid">
                      <label>
                        Bitrate / resolution
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
                    {!isUploadOnlyScope(testScope) &&
                    playbackPolicyToggleVisible(endpoints.map((endpoint) => endpoint.protocol)) ? (
                      <div className="encode-location-options playback-policy-options" role="radiogroup" aria-label="Playback policy">
                        <label className={`source-mode-card${playbackPolicy === PLAYBACK_POLICY_LIVE_EDGE ? " selected" : ""}`}>
                          <input
                            type="radio"
                            name="playback-policy"
                            checked={playbackPolicy === PLAYBACK_POLICY_LIVE_EDGE}
                            disabled={bootstrapping || !apiOnline || loading}
                            onChange={() => setPlaybackPolicy(PLAYBACK_POLICY_LIVE_EDGE)}
                          />
                          <span className="source-mode-card-body">
                            <strong>Live edge</strong>
                            <span className="source-mode-card-hint">{PLAYBACK_POLICY_LIVE_COPY}</span>
                          </span>
                        </label>
                        <label className={`source-mode-card${playbackPolicy === PLAYBACK_POLICY_COMPLETE ? " selected" : ""}`}>
                          <input
                            type="radio"
                            name="playback-policy"
                            checked={playbackPolicy === PLAYBACK_POLICY_COMPLETE}
                            disabled={bootstrapping || !apiOnline || loading}
                            onChange={() => setPlaybackPolicy(PLAYBACK_POLICY_COMPLETE)}
                          />
                          <span className="source-mode-card-body">
                            <strong>Complete</strong>
                            <span className="source-mode-card-hint">{PLAYBACK_POLICY_COMPLETE_COPY}</span>
                          </span>
                        </label>
                      </div>
                    ) : null}
                    <div className="vmaf-section">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={
                            computeVmaf &&
                            (mediaSource === "browser_moq"
                              ? anyIngestVmafAvailable
                              : !isLocalAgentSource(mediaSource) || encoderVmafAvailable)
                          }
                          disabled={
                            !vmafSelectable ||
                            (mediaSource === "browser_moq"
                              ? !anyIngestVmafAvailable
                              : isLocalAgentSource(mediaSource) && !encoderVmafAvailable)
                          }
                          onChange={(e) => setComputeVmaf(e.target.checked)}
                        />
                        <span>Score picture quality</span>
                      </label>
                      <span className="field-hint">
                        {vmafUnavailableReason ??
                          "Calculate VMAF, PSNR, and SSIM pre- and post-ingest"}
                      </span>
                    </div>
                  </div>
                </section>
                </SetupStepFrame>
              </div>

              {(isLastSetupStep(setupSteps, setupCursor) || runLayout) && (
              <PipelineConfigDetails
                sections={pipelineSections}
                diagram={pipelineDiagram}
                buttonLabel="Pipeline"
              />
              )}
            </section>
            </div>

            {!showOutputsPane && error ? (
              <p className="error benchmark-start-error">{error}</p>
            ) : null}
            {!showOutputsPane && !error && startHint && !loading ? (
              <p className="field-hint benchmark-start-error">{startHint}</p>
            ) : null}

            {showOutputsPane && (
            <div className="benchmark-split-run">
            {recipePicked && (
            <div className="outputs-heading-row">
              {showOutputTiles ? (
                <>
              <StepHeading
                step={outputsStep}
                title="Outputs"
                tip={
                  isUploadOnlyScope(testScope)
                    ? showOutputConfig
                      ? "Encode + publish + ingest only. One confidence monitor — no glass tiles or Go Live."
                      : "Pick a cloud per output. Protocol mix is fixed (SRT + RTMP + MoQ :14433). Ingest only — no glass tiles or Go Live."
                    : lockOutputProtocol && showOutputConfig
                      ? "Same protocol on every tile. Pick a cloud endpoint per output. Add or remove region tiles."
                      : "One protocol, ingest, and player per column. Same source and encode."
                }
              />
              {showOutputConfig && canAddOutput && (
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
                </>
              ) : (
                <p className="outputs-locked-heading">Outputs</p>
              )}
            </div>
            )}
            <div className="benchmark-live">
            {recipePicked && (
            <section className="benchmark-streams">
              {endpoints.map((endpoint, index) => {
                const leg = comparisonLegs[index];
                const liveRtt =
                  leg?.latestSample?.net_rtt_ms ?? leg?.latestSample?.transport_rtt_ms;
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
                    {showOutputTiles ? (
                    <EndpointSection
                      index={index}
                      endpoint={endpoint}
                      protocols={protocols}
                      recipeContext={recipeContext}
                      occupiedCollisionKeys={siblingOccupiedCollisionKeys(endpoints, endpoint.id)}
                      bootstrapping={bootstrapping}
                      apiOnline={apiOnline}
                      canRemove={showOutputConfig && endpoints.length > minEndpointsForSource(mediaSource)}
                      lockProtocol={lockOutputProtocol}
                      lockPlayer={lockOutputProtocol}
                      hideCustomDestinations={activePresetId === "cloud-compare"}
                      onChange={updateEndpoint}
                      onRemove={removeEndpoint}
                    />
                    ) : (
                      <p className="stream-column-locked-label">
                        {protocolLabel(endpoint.protocol)} · {playerShortLabel(endpoint)}
                      </p>
                    )}

                    {runLayout && (
                    <div className="stream-column-preview">
                      {isUploadOnlyScope(testScope) ? (
                        <div className="ingest-monitor" data-testid="ingest-monitor">
                          <p className="ingest-monitor-kicker">Ingest monitor — not glass</p>
                          <p className="ingest-monitor-body">
                            {leg?.job.preview_ready === false
                              ? "Waiting for ingest…"
                              : leg
                                ? `${Math.round(leg.latestSample?.fps ?? 0)} fps · ${Math.round(leg.latestSample?.encoded_bitrate_kbps ?? 0)} kbps`
                                : loading
                                  ? "Publishing…"
                                  : "Start a run to watch ingest."}
                          </p>
                        </div>
                      ) : (
                      <div className="stream-player-with-hud">
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
                        encodeLatencyMs={leg?.latestSample?.latency_encode_ms ?? 0}
                        playbackPolicy={parsePlaybackPolicy(
                          leg?.job.playback_policy ?? playbackPolicy,
                        )}
                        netRttMs={
                          leg?.latestSample?.net_rtt_ms ??
                          leg?.latestSample?.transport_rtt_ms ??
                          0
                        }
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
                                    latestSample: overlayPlaybackOnLatestSample(
                                      item.latestSample,
                                      playback,
                                    ),
                                  }
                                : item,
                            ),
                          );
                        }}
                        jobStatus={leg?.job.status}
                        jobError={leg?.job.error}
                        waitingForEncodeSlot={Boolean(leg?.job.waiting_for_encode_slot)}
                        encodeQueueAhead={leg?.job.encode_queue_ahead ?? 0}
                        previewReady={leg?.job.preview_ready}
                        benchmarkLoading={loading}
                        encodeDurationSec={leg?.job.duration_sec ?? 60}
                        encodeElapsedSec={encodeElapsedSecForVerdict({
                          latestElapsedSec: leg?.latestSample?.elapsed_sec,
                          sampleElapsedSecs: leg?.samples.map((sample) => sample.elapsed_sec),
                          startedAtEpoch: leg?.job.started_at_epoch,
                          completedAtMs: leg?.completedAtMs,
                        })}
                        runStopped={Boolean(leg?.job.cancelled)}
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
                        moqVideoCodec={mediaSource === "browser_moq" ? browserVideoCodec : undefined}
                        moqDraftVersion={moqDraftForIngest(endpoint.ingestEndpointId)}
                        moqPinTlsCert={moqPinTlsCertForIngest(endpoint.ingestEndpointId)}
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
                      <PlayerHud
                        visible={Boolean(leg) || loading}
                        ttffMs={leg?.latestSample?.playback_ttff_ms}
                        latencyMs={leg?.latestSample?.e2e_latency_ms}
                        latencyScope={resolveSampleE2eScope({
                          latency_e2e_scope: leg?.latestSample?.latency_e2e_scope,
                          protocol: endpoint.protocol,
                          test_scope: leg?.job.test_scope ?? testScope,
                        })}
                        segmentationMs={leg?.latestSample?.latency_segmentation_ms}
                        latencyCaptureHintMs={captureClassHintMs(
                          leg?.latestSample?.e2e_latency_ms,
                          leg?.latestSample?.latency_encode_ms,
                          resolveSampleE2eScope({
                            latency_e2e_scope: leg?.latestSample?.latency_e2e_scope,
                            protocol: endpoint.protocol,
                            test_scope: leg?.job.test_scope ?? testScope,
                          }),
                        )}
                        ttffBest={liveMetricRanks.ttff.bestIndex === index}
                        latencyBest={liveMetricRanks.latency.bestIndex === index}
                        ttffDeltaMs={liveMetricRanks.ttff.deltaVsBest[index]}
                        latencyDeltaMs={liveMetricRanks.latency.deltaVsBest[index]}
                      />
                      </div>
                      )}
                    </div>
                    )}

                    {(leg || loading) && (
                    <div className="stream-column-status">
                      {leg ? (
                        <>
                          <div className="status-row">
                            <span>Status</span>
                            <strong className={`pill ${leg.job.status}`}>{leg.job.status}</strong>
                          </div>
                          {liveRtt != null && Number.isFinite(liveRtt) && liveRtt > 0 ? (
                            <div className="status-row">
                              <span>RTT</span>
                              <strong
                                className={`metric-figure${liveMetricRanks.rtt.bestIndex === index ? " metric-best" : ""}`}
                              >
                                {Math.round(liveRtt)} ms
                                {liveMetricRanks.rtt.deltaVsBest[index] != null &&
                                liveMetricRanks.rtt.deltaVsBest[index]! > 0 ? (
                                  <span className="metric-delta">
                                    +{liveMetricRanks.rtt.deltaVsBest[index]}
                                  </span>
                                ) : null}
                              </strong>
                            </div>
                          ) : null}
                          <div className="status-row">
                            <span title="Time from encoded bits ready to first successful publish at ingest. Publisher→ingest only — not glass-to-glass.">
                              Upload
                            </span>
                            <strong className="metric-figure">
                              {leg.latestSample?.upload_latency_ms != null &&
                              Number.isFinite(leg.latestSample.upload_latency_ms) &&
                              leg.latestSample.upload_latency_ms > 0
                                ? `${Math.round(leg.latestSample.upload_latency_ms)} ms`
                                : "—"}
                            </strong>
                          </div>
                          {leg.job.error && (
                            <p className="error">{humanizeJobError(leg.job.error) || leg.job.error}</p>
                          )}
                          {leg.encoderVmafRequested ? (
                            <div className="status-row quality">
                              <span>Encoder</span>
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
                          ) : null}
                          {leg.ingestVmafRequested ? (
                            <div className="status-row quality">
                              <span>Ingest</span>
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
                          ) : null}
                          {leg.job.encoder_vmaf_error && (
                            <p className="error">{leg.job.encoder_vmaf_error}</p>
                          )}
                          {leg.job.vmaf_error && <p className="error">{leg.job.vmaf_error}</p>}
                        </>
                      ) : loading ? (
                        <div className="skeleton-shimmer" style={{ height: 64, borderRadius: 12 }} />
                      ) : null}
                    </div>
                    )}
                  </article>
                );
              })}

            </section>
            )}
            </div>

            {error && <p className="error benchmark-start-error">{error}</p>}
            {!error && startHint && !loading && (
              <p className="field-hint benchmark-start-error">{startHint}</p>
            )}
            {loading && (
            <div className="button-row benchmark-start-row">
              {renderStartStop("", { start: false })}
            </div>
            )}

            {!loading &&
              comparisonLegs.length > 0 &&
              comparisonLegs.every((leg) =>
                isLegFinished(leg.job, leg.ingestVmafRequested, leg.encoderVmafRequested),
              ) && (
                <section className="session-download-strip benchmark-download">
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
                  </div>
                </section>
              )}
            </div>
            )}
          </div>
            {(loading || comparisonLegs.some((leg) => leg.samples.length > 0)) && (
              <section className="panel live-charts-panel">
                <h2 className="live-charts-heading">Charts</h2>
                <ResultsErrorBoundary label="live charts">
                <ComparisonCharts
                  minLegs={1}
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
                    const qualityOn = leg.encoderVmafRequested || leg.ingestVmafRequested;
                    return {
                    id: leg.id,
                    label: leg.label,
                    protocol: leg.protocol,
                    ingestEndpointId: endpoint?.ingestEndpointId,
                    playbackMode: endpoint?.playbackMode,
                    endpoint: endpoint?.endpointUrl || leg.job.endpoint_url,
                    samples: useSaved ? [] : leg.samples,
                    result: saved,
                    vmafScore: qualityOn
                      ? saved?.averages?.vmaf_score ?? leg.job.vmaf_score
                      : null,
                    psnrDb: qualityOn
                      ? saved?.averages?.psnr_db ?? leg.job.psnr_db
                      : null,
                    ssim: qualityOn ? saved?.averages?.ssim ?? leg.job.ssim : null,
                    vmafScoreEncoder: qualityOn
                      ? saved?.quality?.encoder?.vmaf_score ?? leg.job.encoder_vmaf_score
                      : null,
                    psnrDbEncoder: qualityOn
                      ? saved?.quality?.encoder?.psnr_db ?? leg.job.encoder_psnr_db
                      : null,
                    ssimEncoder: qualityOn
                      ? saved?.quality?.encoder?.ssim ?? leg.job.encoder_ssim
                      : null,
                    vmafScoreIngest: qualityOn
                      ? saved?.quality?.ingest?.vmaf_score ?? leg.job.vmaf_score
                      : null,
                    psnrDbIngest: qualityOn
                      ? saved?.quality?.ingest?.psnr_db ?? leg.job.psnr_db
                      : null,
                    ssimIngest: qualityOn
                      ? saved?.quality?.ingest?.ssim ?? leg.job.ssim
                      : null,
                    publisherHost: leg.job.publisher_host ?? undefined,
                    qualityAnalysisRequested:
                      leg.encoderVmafRequested || leg.ingestVmafRequested,
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
                </ResultsErrorBoundary>
              </section>
            )}
          </div>
        )}

        {tab === "metrics" && (
          <section className="panel results-panel">
            <div className="results-panel-header">
              <h2>Results</h2>
              <SessionHistory
                refreshToken={sessionHistoryRefreshToken}
                selectedKey={selectedSessionKey}
                eager
                onSelect={(summaries, labels, key) => {
                  setSessionMetrics(summaries);
                  setSessionMetricLabels(labels);
                  setSelectedSessionKey(key);
                  setSessionFromHistory(true);
                }}
              />
            </div>
            <ResultsErrorBoundary label="session">
              <SessionMetrics
                streams={sessionMetrics}
                labels={sessionMetricLabels}
                fromHistory={sessionFromHistory}
              />
            </ResultsErrorBoundary>
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
