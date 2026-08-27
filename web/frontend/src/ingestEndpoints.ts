import type { Preset } from "./types";

/**
 * Nine encode/ingest hosts. Labels are the product names. cloudRegion is the
 * real provider slug (GCP West = us-west1 Oregon, not Iowa; Linode Central =
 * us-central Dallas; AWS Central = us-east-2 Ohio).
 *
 * ingestPrefix keeps live recipe IDs: gcp_* (central), gcp_east_*, linode_* (east).
 */
export const ENCODE_HOSTS = [
  {
    id: "gcp_east",
    provider: "gcp",
    region: "east",
    label: "GCP East",
    cloudRegion: "us-east1",
    ingestPrefix: "gcp_east",
    presetSlug: "gcp_east",
    subtitle: "us-east1",
    defaultAvailable: true,
  },
  {
    id: "gcp_central",
    provider: "gcp",
    region: "central",
    label: "GCP Central",
    cloudRegion: "us-central1",
    ingestPrefix: "gcp",
    presetSlug: "gcp",
    subtitle: "us-central1 (Iowa)",
    defaultAvailable: true,
  },
  {
    id: "gcp_west",
    provider: "gcp",
    region: "west",
    label: "GCP West",
    cloudRegion: "us-west1",
    ingestPrefix: "gcp_west",
    presetSlug: "gcp_west",
    subtitle: "us-west1 (Oregon)",
    defaultAvailable: false,
  },
  {
    id: "linode_east",
    provider: "linode",
    region: "east",
    label: "Linode East",
    cloudRegion: "us-east",
    ingestPrefix: "linode",
    presetSlug: "linode",
    subtitle: "us-east (Newark)",
    defaultAvailable: false,
  },
  {
    id: "linode_central",
    provider: "linode",
    region: "central",
    label: "Linode Central",
    cloudRegion: "us-central",
    ingestPrefix: "linode_central",
    presetSlug: "linode_central",
    subtitle: "us-central (Dallas)",
    defaultAvailable: false,
  },
  {
    id: "linode_west",
    provider: "linode",
    region: "west",
    label: "Linode West",
    cloudRegion: "us-west",
    ingestPrefix: "linode_west",
    presetSlug: "linode_west",
    subtitle: "us-west (Fremont)",
    defaultAvailable: false,
  },
  {
    id: "aws_east",
    provider: "aws",
    region: "east",
    label: "AWS East",
    cloudRegion: "us-east-1",
    ingestPrefix: "aws_east",
    presetSlug: "aws_east",
    subtitle: "us-east-1",
    defaultAvailable: false,
  },
  {
    id: "aws_central",
    provider: "aws",
    region: "central",
    label: "AWS Central",
    cloudRegion: "us-east-2",
    ingestPrefix: "aws_central",
    presetSlug: "aws_central",
    subtitle: "us-east-2 (Ohio)",
    defaultAvailable: false,
  },
  {
    id: "aws_west",
    provider: "aws",
    region: "west",
    label: "AWS West",
    cloudRegion: "us-west-2",
    ingestPrefix: "aws_west",
    presetSlug: "aws_west",
    subtitle: "us-west-2",
    defaultAvailable: false,
  },
] as const;

export type EncodeHostDef = (typeof ENCODE_HOSTS)[number];
export type CloudEncodeHostId = EncodeHostDef["id"];
type HostIngestPrefix = EncodeHostDef["ingestPrefix"];

export type IngestEndpointId =
  | `${HostIngestPrefix}_zixi`
  | `${HostIngestPrefix}_mediamtx`
  | `${HostIngestPrefix}_moq_relay`
  | `${HostIngestPrefix}_moq_relay_d18`
  | "custom"
  | "aws_zixi";

export interface IngestEndpointOption {
  id: IngestEndpointId;
  label: string;
  detail: string;
  available: boolean;
}

const HOST_BY_ID: Record<CloudEncodeHostId, EncodeHostDef> = Object.fromEntries(
  ENCODE_HOSTS.map((host) => [host.id, host]),
) as Record<CloudEncodeHostId, EncodeHostDef>;

const HOSTS_LONGEST_PREFIX = [...ENCODE_HOSTS].sort(
  (left, right) => right.ingestPrefix.length - left.ingestPrefix.length,
);

const LEGACY_HOST_ALIASES: Record<string, CloudEncodeHostId> = {
  gcp: "gcp_central",
  linode: "linode_east",
  aws: "aws_east",
};

export const CLOUD_ENCODE_HOST_IDS: CloudEncodeHostId[] = ENCODE_HOSTS.map((host) => host.id);

const INGEST_ROLES = [
  {
    role: "zixi" as const,
    labelPrefix: "Zixi",
    detail: "Broadcaster Fast HLS / MPEG-TS",
  },
  {
    role: "mediamtx" as const,
    labelPrefix: "MediaMTX",
    detail: "LL-HLS / LL-DASH / WHEP",
  },
  {
    role: "moq_relay" as const,
    labelPrefix: "OpenMOQ draft-16",
    detail: "Legacy :4433 / moqt-16. Hidden — same stall as draft-18, not actively worked.",
  },
  {
    role: "moq_relay_d18" as const,
    labelPrefix: "OpenMOQ",
    detail: "WebTransport :14433 · moqt-18",
  },
];

function ingestIdFor(host: EncodeHostDef, role: (typeof INGEST_ROLES)[number]["role"]): IngestEndpointId {
  return `${host.ingestPrefix}_${role}` as IngestEndpointId;
}

function presetIdsFor(
  host: EncodeHostDef,
  role: (typeof INGEST_ROLES)[number]["role"],
): Partial<Record<string, string>> {
  const slug = host.presetSlug;
  if (role === "zixi") {
    return {
      srt: `moq_zixi_${slug}`,
      rtmp: `moq_zixi_${slug}_rtmp`,
      hls: `moq_zixi_${slug}_hls`,
      dash: `moq_zixi_${slug}_dash`,
    };
  }
  if (role === "mediamtx") {
    return {
      srt: `moq_mediamtx_${slug}_srt`,
      rtmp: `moq_mediamtx_${slug}_rtmp`,
      webrtc: `moq_mediamtx_${slug}_whip`,
    };
  }
  if (role === "moq_relay") {
    return { moq: `moq_${slug}_relay` };
  }
  return { moq: `moq_${slug}_relay_d18` };
}

const INGEST_ENDPOINT_DEFS: Omit<IngestEndpointOption, "available">[] = [
  ...ENCODE_HOSTS.flatMap((host) =>
    INGEST_ROLES.map((role) => ({
      id: ingestIdFor(host, role.role),
      label: `${role.labelPrefix} · ${host.label}`,
      detail: role.detail,
    })),
  ),
  {
    id: "custom",
    label: "Custom URL",
    detail: "Provide your own ingest endpoint.",
  },
];

/** Draft-16 :4433 stays up but is not offered. Same stall; draft-18 is the MoQ path. */
export const RECIPE_HIDDEN_INGEST_IDS: ReadonlySet<string> = new Set(
  ENCODE_HOSTS.map((host) => ingestIdFor(host, "moq_relay")),
);

/** Static list (legacy). Prefer `ingestEndpointsFromPresets` when presets are loaded. */
export const INGEST_ENDPOINTS: IngestEndpointOption[] = INGEST_ENDPOINT_DEFS.map((item) => ({
  ...item,
  available:
    item.id === "custom" ||
    (!RECIPE_HIDDEN_INGEST_IDS.has(item.id) &&
      encodeHostById(cloudHostFromIngest(item.id)).defaultAvailable),
}));

const ENDPOINT_PROVIDER: Record<string, string> = Object.fromEntries(
  INGEST_ENDPOINT_DEFS.map((item) => [item.id, item.id]),
);
ENDPOINT_PROVIDER.custom = "";
ENDPOINT_PROVIDER.aws_zixi = "aws_east_zixi";

const PRESET_IDS_BY_ENDPOINT: Record<string, Partial<Record<string, string>>> = Object.fromEntries(
  ENCODE_HOSTS.flatMap((host) =>
    INGEST_ROLES.map((role) => [ingestIdFor(host, role.role), presetIdsFor(host, role.role)]),
  ),
);
PRESET_IDS_BY_ENDPOINT.custom = {};
PRESET_IDS_BY_ENDPOINT.aws_zixi = presetIdsFor(HOST_BY_ID.aws_east, "zixi");

function encodeHostById(host: CloudEncodeHostId): EncodeHostDef {
  return HOST_BY_ID[host];
}

export function normalizeCloudHost(host: string): CloudEncodeHostId {
  if (host in HOST_BY_ID) {
    return host as CloudEncodeHostId;
  }
  return LEGACY_HOST_ALIASES[host] ?? "gcp_central";
}

export function encodeHostProvider(host: CloudEncodeHostId): EncodeHostDef["provider"] {
  return encodeHostById(normalizeCloudHost(host)).provider;
}

export function encodeHostRank(host: CloudEncodeHostId): number {
  const index = ENCODE_HOSTS.findIndex((item) => item.id === normalizeCloudHost(host));
  return index < 0 ? ENCODE_HOSTS.length : index;
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
  if (presets.length === 0) {
    return encodeHostById(cloudHostFromIngest(endpointId)).defaultAvailable;
  }
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
    return encodeHostById(cloudHostFromIngest(ingestEndpointId)).defaultAvailable;
  }
  const preset = presets.find((item) => item.id === presetId);
  return preset?.web_available !== false && Boolean(preset);
}

export function ingestEndpointsFromPresets(presets: Preset[]): IngestEndpointOption[] {
  return INGEST_ENDPOINT_DEFS.map((item) => {
    const available = endpointAvailable(item.id, presets);
    const presetIds = Object.values(PRESET_IDS_BY_ENDPOINT[item.id] ?? {});
    const downNote = presets.find(
      (preset) => presetIds.includes(preset.id) && preset.web_available === false && preset.notes,
    )?.notes;
    return {
      ...item,
      available,
      detail: available
        ? item.detail
        : downNote || `Not deployed · ${encodeHostById(cloudHostFromIngest(item.id)).subtitle}`,
    };
  });
}

export const INGEST_PRESET_BY_PROTOCOL = PRESET_IDS_BY_ENDPOINT;

/** Draft-18 :14433 and leftover draft-16 :4433 both count as managed MoQ relays. */
export function isMoqRelayIngest(ingestEndpointId: string): boolean {
  return ingestEndpointId.includes("_moq_relay");
}

/** Headed Chrome playa / in-page publisher: 18 on the public :14433 ingest. */
export function moqDraftForIngest(ingestEndpointId: string): 16 | 18 {
  return ingestEndpointId.includes("moq_relay_d18") ? 18 : 16;
}

/** Prod :4433 uses a ≤14-day WT cert + hash pin. Canary :14433 uses public LE. */
export function moqPinTlsCertForIngest(ingestEndpointId: string): boolean {
  return !ingestEndpointId.includes("moq_relay_d18");
}

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
  const url = presets.find((preset) => preset.id === presetId)?.url?.trim() ?? "";
  // A draft-18 ingest must never publish to prod :4433, even if a stale
  // preset URL is mis-wired. Empty URL fails Start instead of going silent.
  if (endpoint.ingestEndpointId.includes("moq_relay_d18") && url.includes(":4433") && !url.includes(":14433")) {
    return "";
  }
  return url;
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
  return PRESET_IDS_BY_ENDPOINT[ingestEndpointId]?.[protocol];
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
  if (isCustomIngestEndpoint(ingestEndpointId) || !ingestEndpointId) {
    return "gcp_central";
  }
  for (const host of HOSTS_LONGEST_PREFIX) {
    if (ingestEndpointId === host.ingestPrefix || ingestEndpointId.startsWith(`${host.ingestPrefix}_`)) {
      return host.id;
    }
  }
  if (ingestEndpointId.startsWith("aws_")) {
    return "aws_east";
  }
  return "gcp_central";
}

export function ingestPrefixForCloudHost(host: CloudEncodeHostId): string {
  return encodeHostById(normalizeCloudHost(host)).ingestPrefix;
}

export function ingestRole(ingestEndpointId: string): "zixi" | "mediamtx" | "moq_relay" | null {
  if (isMoqRelayIngest(ingestEndpointId)) {
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
  const prefix = ingestPrefixForCloudHost(host);
  // Draft-18 canaries stay on :14433 in the chosen cloud (never remap to :4433).
  if (ingestEndpointId.endsWith("moq_relay_d18")) {
    return `${prefix}_moq_relay_d18` as IngestEndpointId;
  }
  const role = ingestRole(ingestEndpointId);
  if (!role) {
    return ingestEndpointId as IngestEndpointId;
  }
  return `${prefix}_${role}` as IngestEndpointId;
}

/** Default host for a freshly chosen upload protocol. */
export function defaultIngestForProtocol(
  protocol: string,
  host: CloudEncodeHostId = "gcp_central",
): IngestEndpointId {
  const prefix = ingestPrefixForCloudHost(host);
  const preferred: IngestEndpointId =
    protocol === "moq"
      ? (`${prefix}_moq_relay_d18` as IngestEndpointId)
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
  const d18 = preferred.endsWith("_d18") && role === "moq_relay" ? "_d18" : "";
  for (const fallback of ["gcp_central", "gcp_east", "linode_east"] as CloudEncodeHostId[]) {
    const candidate = `${ingestPrefixForCloudHost(fallback)}_${role}${d18}` as IngestEndpointId;
    if (!RECIPE_HIDDEN_INGEST_IDS.has(candidate)) {
      return candidate;
    }
  }
  return preferred;
}

/** Host options for the selected upload protocol. Undeployed hosts stay visible. */
export function ingestEndpointsForProtocol(protocol: string, presets: Preset[] = []) {
  const options = presets.length > 0 ? ingestEndpointsFromPresets(presets) : INGEST_ENDPOINTS;
  const forProtocol =
    protocol === "moq"
      ? options.filter((item) => isMoqRelayIngest(item.id) || item.id === "custom")
      : protocol === "webrtc"
        ? options.filter((item) => item.id.endsWith("_mediamtx") || item.id === "custom")
        : options.filter((item) => !isMoqRelayIngest(item.id));
  return forProtocol.filter((item) => {
    if (RECIPE_HIDDEN_INGEST_IDS.has(item.id)) {
      return false;
    }
    if (item.id === "custom") {
      return true;
    }
    return Boolean(presetIdForIngest(item.id, protocol));
  });
}

function browserPublishIngestId(endpoint: {
  protocol: string;
  ingestEndpointId: string;
}): IngestEndpointId {
  if (endpoint.protocol === "webrtc") {
    return defaultIngestForProtocol("webrtc", cloudHostFromIngest(endpoint.ingestEndpointId));
  }
  if (isMoqRelayIngest(endpoint.ingestEndpointId)) {
    const id = endpoint.ingestEndpointId;
    if (RECIPE_HIDDEN_INGEST_IDS.has(id) && !id.endsWith("_d18")) {
      return `${id}_d18` as IngestEndpointId;
    }
    return id as IngestEndpointId;
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
  if (preset?.cloud_provider || preset?.cloud_region) {
    return {
      cloud_provider: preset.cloud_provider,
      cloud_region: preset.cloud_region,
    };
  }
  const host = encodeHostById(cloudHostFromIngest(ingestEndpointId));
  return { cloud_provider: host.provider, cloud_region: host.cloudRegion };
}
