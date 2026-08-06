import type { Preset } from "./types";

export type IngestEndpointId =
  | "gcp_zixi"
  | "gcp_mediamtx"
  | "gcp_moq_relay"
  | "linode_zixi"
  | "linode_mediamtx"
  | "linode_moq_relay"
  | "aws_zixi"
  | "custom";

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

/** Static list (legacy). Prefer `ingestEndpointsFromPresets` when presets are loaded. */
export const INGEST_ENDPOINTS: IngestEndpointOption[] = INGEST_ENDPOINT_DEFS.map((item) => ({
  ...item,
  available:
    item.id === "custom" || item.id.startsWith("gcp_"),
}));

const ENDPOINT_PROVIDER: Record<IngestEndpointId, string | ""> = {
  gcp_zixi: "gcp_zixi",
  gcp_mediamtx: "gcp_mediamtx",
  gcp_moq_relay: "gcp_moq_relay",
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

function linodeRegionLabel(presets: Preset[]): string {
  const linode = presets.find(
    (preset) => preset.cloud_provider === "linode" && preset.cloud_region && preset.web_available,
  );
  return linode?.cloud_region ? ` · ${linode.cloud_region}` : "";
}

function endpointAvailable(endpointId: IngestEndpointId, presets: Preset[]): boolean {
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

export function ingestEndpointsFromPresets(presets: Preset[]): IngestEndpointOption[] {
  const linodeSuffix = linodeRegionLabel(presets);
  return INGEST_ENDPOINT_DEFS.map((item) => {
    const available = endpointAvailable(item.id, presets);
    let label = item.label;
    if (item.id.startsWith("linode_") && linodeSuffix) {
      label = label.replace(" · Linode", ` · Linode${linodeSuffix}`);
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
  if (ingestEndpointId === "gcp_mediamtx" || ingestEndpointId === "linode_mediamtx") {
    return ingestEndpointId;
  }
  if (ingestEndpointId === "gcp_zixi" || ingestEndpointId === "linode_zixi" || ingestEndpointId === "aws_zixi") {
    return `${ingestEndpointId}:${protocol === "srt" ? "srt" : "benchmark"}`;
  }
  return `${ingestEndpointId}:${protocol}`;
}

/** Default host for a freshly chosen upload protocol. */
export function defaultIngestForProtocol(protocol: string): IngestEndpointId {
  if (protocol === "moq") {
    return "gcp_moq_relay";
  }
  if (protocol === "srt") {
    return "gcp_mediamtx";
  }
  if (protocol === "webrtc") {
    return "gcp_mediamtx";
  }
  return "gcp_zixi";
}

/** Host options that make sense for the selected upload protocol. */
export function ingestEndpointsForProtocol(protocol: string, presets: Preset[] = []) {
  const options = presets.length > 0 ? ingestEndpointsFromPresets(presets) : INGEST_ENDPOINTS;
  if (protocol === "moq") {
    return options.filter(
      (item) =>
        item.id === "gcp_moq_relay" || item.id === "linode_moq_relay" || item.id === "custom",
    );
  }
  return options.filter(
    (item) => item.id !== "gcp_moq_relay" && item.id !== "linode_moq_relay",
  );
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
