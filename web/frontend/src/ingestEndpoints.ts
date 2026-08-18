import type { Preset } from "./types";

export type IngestEndpointId =
  | "gcp_zixi"
  | "gcp_mediamtx"
  | "gcp_moq_relay"
  | "gcp_east_zixi"
  | "gcp_east_mediamtx"
  | "gcp_east_moq_relay"
  | "linode_zixi"
  | "linode_mediamtx"
  | "linode_moq_relay"
  | "aws_zixi"
  | "custom";

export type CloudEncodeHostId = "gcp" | "gcp_east" | "linode" | "aws";

export interface IngestEndpointOption {
  id: IngestEndpointId;
  label: string;
  detail: string;
  available: boolean;
}

const INGEST_ENDPOINT_DEFS: Omit<IngestEndpointOption, "available">[] = [
  {
    id: "gcp_zixi",
    label: "Zixi · GCP us-central1",
    detail: "Broadcaster Fast HLS / MPEG-TS",
  },
  {
    id: "gcp_mediamtx",
    label: "MediaMTX · GCP us-central1",
    detail: "LL-HLS / LL-DASH / WHEP",
  },
  {
    id: "gcp_moq_relay",
    label: "OpenMOQ · GCP us-central1",
    detail: "MoQ relay (WebTransport)",
  },
  {
    id: "gcp_east_zixi",
    label: "Zixi · GCP us-east1",
    detail: "Broadcaster Fast HLS / MPEG-TS",
  },
  {
    id: "gcp_east_mediamtx",
    label: "MediaMTX · GCP us-east1",
    detail: "LL-HLS / LL-DASH / WHEP",
  },
  {
    id: "gcp_east_moq_relay",
    label: "OpenMOQ · GCP us-east1",
    detail: "MoQ relay (WebTransport)",
  },
  {
    id: "linode_zixi",
    label: "Zixi · Linode",
    detail: "Broadcaster Fast HLS / MPEG-TS",
  },
  {
    id: "linode_mediamtx",
    label: "MediaMTX · Linode",
    detail: "LL-HLS / LL-DASH / WHEP",
  },
  {
    id: "linode_moq_relay",
    label: "OpenMOQ · Linode",
    detail: "MoQ relay (WebTransport)",
  },
  {
    id: "aws_zixi",
    label: "Zixi · AWS",
    detail: "Coming soon",
  },
  {
    id: "custom",
    label: "Custom URL",
    detail: "Your origin / gateway",
  },
];

/** Hosts hidden from web recipes. Empty while all configured stacks are live. */
export const RECIPE_HIDDEN_INGEST_IDS: ReadonlySet<string> = new Set();

/** Static list (legacy). Prefer `ingestEndpointsFromPresets` when presets are loaded. */
export const INGEST_ENDPOINTS: IngestEndpointOption[] = INGEST_ENDPOINT_DEFS.map((item) => ({
  ...item,
  available:
    item.id === "custom" ||
    (!RECIPE_HIDDEN_INGEST_IDS.has(item.id) && item.id.startsWith("gcp_")),
}));

const ENDPOINT_PROVIDER: Record<IngestEndpointId, string | ""> = {
  gcp_zixi: "gcp_zixi",
  gcp_mediamtx: "gcp_mediamtx",
  gcp_moq_relay: "gcp_moq_relay",
  gcp_east_zixi: "gcp_east_zixi",
  gcp_east_mediamtx: "gcp_east_mediamtx",
  gcp_east_moq_relay: "gcp_east_moq_relay",
  linode_zixi: "linode_zixi",
  linode_mediamtx: "linode_mediamtx",
  linode_moq_relay: "linode_moq_relay",
  aws_zixi: "aws_zixi",
  custom: "",
};

const PRESET_IDS_BY_ENDPOINT: Record<IngestEndpointId, Partial<Record<string, string>>> = {
  gcp_zixi: {
    srt: "moq_zixi_gcp",
    rtmp: "moq_zixi_gcp_rtmp",
    hls: "moq_zixi_gcp_hls",
    dash: "moq_zixi_gcp_dash",
  },
  gcp_mediamtx: {
    srt: "moq_mediamtx_gcp_srt",
    rtmp: "moq_mediamtx_gcp_rtmp",
    webrtc: "moq_mediamtx_gcp_whip",
  },
  gcp_moq_relay: {
    moq: "moq_gcp_relay",
  },
  gcp_east_zixi: {
    srt: "moq_zixi_gcp_east",
    rtmp: "moq_zixi_gcp_east_rtmp",
    hls: "moq_zixi_gcp_east_hls",
    dash: "moq_zixi_gcp_east_dash",
  },
  gcp_east_mediamtx: {
    srt: "moq_mediamtx_gcp_east_srt",
    rtmp: "moq_mediamtx_gcp_east_rtmp",
    webrtc: "moq_mediamtx_gcp_east_whip",
  },
  gcp_east_moq_relay: {
    moq: "moq_gcp_east_relay",
  },
  linode_zixi: {
    srt: "moq_zixi_linode",
    rtmp: "moq_zixi_linode_rtmp",
    hls: "moq_zixi_linode_hls",
    dash: "moq_zixi_linode_dash",
  },
  linode_mediamtx: {
    srt: "moq_mediamtx_linode_srt",
    rtmp: "moq_mediamtx_linode_rtmp",
    webrtc: "moq_mediamtx_linode_whip",
  },
  linode_moq_relay: {
    moq: "moq_linode_relay",
  },
  aws_zixi: {
    srt: "zixi_aws_srt",
    rtmp: "zixi_aws_rtmp",
    hls: "zixi_aws_hls",
    dash: "zixi_aws_dash",
  },
  custom: {},
};

function regionLabelForProvider(presets: Preset[], ingestPrefix: string): string {
  const match = presets.find(
    (preset) =>
      (preset.ingest_provider || "").startsWith(`${ingestPrefix}_`) &&
      preset.cloud_region &&
      preset.web_available,
  );
  return match?.cloud_region ? ` · ${match.cloud_region}` : "";
}

function endpointAvailable(endpointId: IngestEndpointId, presets: Preset[]): boolean {
  if (RECIPE_HIDDEN_INGEST_IDS.has(endpointId)) {
    return false;
  }
  if (endpointId === "custom") {
    return true;
  }
  const provider = ENDPOINT_PROVIDER[endpointId];
  if (!provider) {
    return false;
  }
  const presetIds = Object.values(PRESET_IDS_BY_ENDPOINT[endpointId] ?? {});
  if (presetIds.length > 0) {
    return presetIds.some((presetId) => {
      const preset = presets.find((item) => item.id === presetId);
      return Boolean(preset?.web_available);
    });
  }
  return presets.some(
    (preset) => preset.ingest_provider === provider && preset.web_available !== false,
  );
}

/** True when this host+protocol maps to a live preset (or presets are not loaded yet). */
export function isIngestEndpointIdAvailable(
  ingestEndpointId: string,
  protocol: string,
  presets: Preset[],
): boolean {
  if (RECIPE_HIDDEN_INGEST_IDS.has(ingestEndpointId)) {
    return false;
  }
  if (isCustomIngestEndpoint(ingestEndpointId)) {
    return true;
  }
  const presetId = presetIdForIngest(ingestEndpointId, protocol);
  if (!presetId) {
    return false;
  }
  if (presets.length === 0) {
    return true;
  }
  const preset = presets.find((item) => item.id === presetId);
  return preset?.web_available !== false && Boolean(preset);
}

export function ingestEndpointsFromPresets(presets: Preset[]): IngestEndpointOption[] {
  const linodeSuffix = regionLabelForProvider(presets, "linode");
  const eastSuffix = regionLabelForProvider(presets, "gcp_east");
  return INGEST_ENDPOINT_DEFS.map((item) => {
    const available = endpointAvailable(item.id, presets);
    let label = item.label;
    if (item.id.startsWith("linode_") && linodeSuffix) {
      label = label.replace(" · Linode", ` · Linode${linodeSuffix}`);
    }
    if (item.id.startsWith("gcp_east_") && eastSuffix) {
      label = label.replace(" · GCP us-east1", ` · GCP${eastSuffix}`);
    }
    return {
      ...item,
      label,
      available,
      detail: available ? item.detail : item.id === "aws_zixi" ? "Coming soon" : item.detail,
    };
  });
}

export const INGEST_PRESET_BY_PROTOCOL = PRESET_IDS_BY_ENDPOINT;

export function resolveEndpointUrl(
  endpoint: { ingestEndpointId: string; protocol: string; endpointUrl: string },
  presets: { id: string; url?: string }[],
): string {
  if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
    return endpoint.endpointUrl.trim();
  }
  const presetId = presetIdForIngest(endpoint.ingestEndpointId, endpoint.protocol);
  if (!presetId) {
    return "";
  }
  return presets.find((preset) => preset.id === presetId)?.url?.trim() ?? "";
}

export function ingestEndpointIdForPreset(presetId: string): IngestEndpointId | "custom" {
  for (const [endpointId, protocols] of Object.entries(PRESET_IDS_BY_ENDPOINT)) {
    if (Object.values(protocols).includes(presetId)) {
      return endpointId as IngestEndpointId;
    }
  }
  return "custom";
}

export function presetIdForIngest(
  ingestEndpointId: string,
  protocol: string,
): string | undefined {
  if (ingestEndpointId === "custom") {
    return undefined;
  }
  return PRESET_IDS_BY_ENDPOINT[ingestEndpointId as IngestEndpointId]?.[protocol];
}

export function ingestEndpointLabel(ingestEndpointId: string): string {
  if (ingestEndpointId === "custom") {
    return "Custom URL";
  }
  return (
    INGEST_ENDPOINT_DEFS.find((endpoint) => endpoint.id === ingestEndpointId)?.label ??
    ingestEndpointId
  );
}

export function isCustomIngestEndpoint(ingestEndpointId: string): boolean {
  return ingestEndpointId === "custom";
}

/**
 * Physical publish "slot" a given ingest+protocol combination occupies.
 * Returns null when the combination can never collide with another leg.
 *
 * MediaMTX publishes every protocol to the same fixed path per host (e.g.
 * "benchmark"), so an SRT leg and an RTMP leg on the *same* MediaMTX host
 * collide even though they're different protocols — MediaMTX only allows one
 * active publisher per path. Zixi instead gives SRT its own named input
 * ("SRT Test") that's independent from RTMP/HLS/DASH (all "benchmark"), so
 * only some protocol groups collide there. MoQ relays hand out a randomized
 * namespace per leg and never collide; "custom" URLs are the user's
 * responsibility.
 */
export function ingestCollisionKey(ingestEndpointId: string, protocol: string): string | null {
  if (protocol === "moq" || isCustomIngestEndpoint(ingestEndpointId)) {
    return null;
  }
  if (ingestEndpointId.endsWith("_mediamtx")) {
    return ingestEndpointId;
  }
  if (ingestEndpointId.endsWith("_zixi")) {
    return `${ingestEndpointId}:${protocol === "srt" ? "srt" : "benchmark"}`;
  }
  return `${ingestEndpointId}:${protocol}`;
}

export function cloudHostFromIngest(ingestEndpointId: string): CloudEncodeHostId {
  if (ingestEndpointId.startsWith("gcp_east_")) {
    return "gcp_east";
  }
  if (ingestEndpointId.startsWith("linode_")) {
    return "linode";
  }
  if (ingestEndpointId.startsWith("aws_")) {
    return "aws";
  }
  return "gcp";
}

export function ingestPrefixForCloudHost(host: CloudEncodeHostId): string {
  if (host === "gcp_east") {
    return "gcp_east";
  }
  if (host === "linode" || host === "aws") {
    return host;
  }
  return "gcp";
}

export function ingestRole(ingestEndpointId: string): "zixi" | "mediamtx" | "moq_relay" | null {
  if (ingestEndpointId.endsWith("_moq_relay")) {
    return "moq_relay";
  }
  if (ingestEndpointId.endsWith("_mediamtx")) {
    return "mediamtx";
  }
  if (ingestEndpointId.endsWith("_zixi")) {
    return "zixi";
  }
  return null;
}

export function remapIngestToCloudHost(
  ingestEndpointId: string,
  host: CloudEncodeHostId,
): IngestEndpointId {
  if (isCustomIngestEndpoint(ingestEndpointId)) {
    return "custom";
  }
  const role = ingestRole(ingestEndpointId);
  if (!role) {
    return ingestEndpointId as IngestEndpointId;
  }
  return `${ingestPrefixForCloudHost(host)}_${role}` as IngestEndpointId;
}

/** Default host for a freshly chosen upload protocol. */
export function defaultIngestForProtocol(
  protocol: string,
  host: CloudEncodeHostId = "gcp",
): IngestEndpointId {
  const prefix = ingestPrefixForCloudHost(host);
  const preferred: IngestEndpointId =
    protocol === "moq"
      ? (`${prefix}_moq_relay` as IngestEndpointId)
      : protocol === "srt" || protocol === "webrtc"
        ? (`${prefix}_mediamtx` as IngestEndpointId)
        : (`${prefix}_zixi` as IngestEndpointId);
  if (!RECIPE_HIDDEN_INGEST_IDS.has(preferred)) {
    return preferred;
  }
  const role = ingestRole(preferred);
  if (!role) {
    return preferred;
  }
  for (const fallback of ["gcp_east", "linode", "gcp"] as CloudEncodeHostId[]) {
    const candidate = `${ingestPrefixForCloudHost(fallback)}_${role}` as IngestEndpointId;
    if (!RECIPE_HIDDEN_INGEST_IDS.has(candidate)) {
      return candidate;
    }
  }
  return preferred;
}

/** Host options that make sense for the selected upload protocol. */
export function ingestEndpointsForProtocol(protocol: string, presets: Preset[] = []) {
  const options = presets.length > 0 ? ingestEndpointsFromPresets(presets) : INGEST_ENDPOINTS;
  const forProtocol =
    protocol === "moq"
      ? options.filter((item) => item.id.endsWith("_moq_relay") || item.id === "custom")
      : protocol === "webrtc"
        ? options.filter((item) => item.id.endsWith("_mediamtx") || item.id === "custom")
        : options.filter((item) => !item.id.endsWith("_moq_relay"));
  // Hide unconfigured / roadmap / broken hosts instead of greying them out.
  return forProtocol.filter((item) => {
    if (RECIPE_HIDDEN_INGEST_IDS.has(item.id)) {
      return false;
    }
    if (item.id === "custom") {
      return true;
    }
    if (!item.available) {
      return false;
    }
    return isIngestEndpointIdAvailable(item.id, protocol, presets);
  });
}

function browserPublishIngestId(endpoint: {
  protocol: string;
  ingestEndpointId: string;
}): IngestEndpointId {
  if (endpoint.protocol === "webrtc") {
    return defaultIngestForProtocol("webrtc", cloudHostFromIngest(endpoint.ingestEndpointId));
  }
  return defaultIngestForProtocol("moq", cloudHostFromIngest(endpoint.ingestEndpointId));
}

/**
 * Browser encode publishes MoQ and/or WebRTC. Convert leftover SRT/RTMP
 * cards: first unused → MoQ, next → WebRTC on that cloud's MediaMTX.
 */
export function collapseOutputsForBrowserMoq<
  T extends {
    protocol: string;
    ingestEndpointId: string;
    endpointUrl?: string;
    moqRelayUrl?: string;
    playbackMode?: string;
  },
>(endpoints: T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  let changed = false;
  let assignedMoq = false;
  for (const endpoint of endpoints) {
    let protocol = endpoint.protocol;
    let ingest = endpoint.ingestEndpointId;
    let playbackMode = endpoint.playbackMode;
    if (protocol !== "moq" && protocol !== "webrtc") {
      if (!assignedMoq) {
        protocol = "moq";
        ingest = defaultIngestForProtocol("moq", cloudHostFromIngest(endpoint.ingestEndpointId));
        playbackMode = "moq";
      } else {
        protocol = "webrtc";
        ingest = defaultIngestForProtocol("webrtc", cloudHostFromIngest(endpoint.ingestEndpointId));
        playbackMode = "whep";
      }
      changed = true;
    } else {
      ingest = browserPublishIngestId({ protocol, ingestEndpointId: ingest });
      if (endpoint.ingestEndpointId !== ingest) {
        changed = true;
      }
      if (protocol === "moq") {
        playbackMode = "moq";
      } else if (!playbackMode || playbackMode === "moq") {
        playbackMode = "whep";
      }
    }
    const key = isCustomIngestEndpoint(ingest)
      ? `${protocol}:custom:${(endpoint.moqRelayUrl || endpoint.endpointUrl || "").trim()}`
      : `${protocol}:${ingest}`;
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    if (protocol === "moq") {
      assignedMoq = true;
    }
    if (
      endpoint.protocol === protocol &&
      endpoint.ingestEndpointId === ingest &&
      endpoint.playbackMode === playbackMode
    ) {
      result.push(endpoint);
      continue;
    }
    changed = true;
    result.push({
      ...endpoint,
      protocol,
      ingestEndpointId: ingest,
      playbackMode,
    });
  }
  return changed ? result : endpoints;
}

export function cloudRegionForIngest(
  ingestEndpointId: string,
  protocol: string,
  presets: Preset[],
): { cloud_provider?: string; cloud_region?: string } {
  const presetId = presetIdForIngest(ingestEndpointId, protocol);
  if (!presetId) {
    return {};
  }
  const preset = presets.find((item) => item.id === presetId);
  return {
    cloud_provider: preset?.cloud_provider,
    cloud_region: preset?.cloud_region,
  };
}
