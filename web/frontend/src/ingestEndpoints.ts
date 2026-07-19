export const INGEST_ENDPOINTS = [
  {
    id: "gcp_zixi",
    label: "Zixi · GCP us-central1",
    detail: "Broadcaster Fast HLS / MPEG-TS",
    available: true,
  },
  {
    id: "gcp_mediamtx",
    label: "MediaMTX · GCP us-central1",
    detail: "LL-HLS / LL-DASH / WHEP",
    available: true,
  },
  {
    id: "gcp_moq_relay",
    label: "OpenMOQ · GCP us-central1",
    detail: "MoQ relay (WebTransport)",
    available: true,
  },
  { id: "aws_zixi", label: "Zixi · AWS", detail: "Coming soon", available: false },
  { id: "linode_zixi", label: "Zixi · Linode", detail: "Coming soon", available: false },
  { id: "custom", label: "Custom URL", detail: "Your origin / gateway", available: true },
] as const;

export type IngestEndpointId = (typeof INGEST_ENDPOINTS)[number]["id"];

export const INGEST_PRESET_BY_PROTOCOL: Record<IngestEndpointId, Partial<Record<string, string>>> = {
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
  aws_zixi: {
    srt: "zixi_aws_srt",
    rtmp: "zixi_aws_rtmp",
    hls: "zixi_aws_hls",
    dash: "zixi_aws_dash",
  },
  linode_zixi: {
    srt: "zixi_linode_srt",
    rtmp: "zixi_linode_rtmp",
    hls: "zixi_linode_hls",
    dash: "zixi_linode_dash",
  },
};

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
  return INGEST_PRESET_BY_PROTOCOL[ingestEndpointId as IngestEndpointId]?.[protocol];
}

export function ingestEndpointLabel(ingestEndpointId: string): string {
  if (ingestEndpointId === "custom") {
    return "Custom URL";
  }
  return INGEST_ENDPOINTS.find((endpoint) => endpoint.id === ingestEndpointId)?.label ?? ingestEndpointId;
}

export function isCustomIngestEndpoint(ingestEndpointId: string): boolean {
  return ingestEndpointId === "custom";
}

/** Default host for a freshly chosen upload protocol. */
export function defaultIngestForProtocol(protocol: string): IngestEndpointId {
  if (protocol === "moq") {
    return "gcp_moq_relay";
  }
  // SRT races MediaMTX LL-HLS by default; Zixi remains selectable manually.
  if (protocol === "srt") {
    return "gcp_mediamtx";
  }
  if (protocol === "webrtc") {
    return "gcp_mediamtx";
  }
  return "gcp_zixi";
}

/** Host options that make sense for the selected upload protocol. */
export function ingestEndpointsForProtocol(protocol: string) {
  if (protocol === "moq") {
    return INGEST_ENDPOINTS.filter(
      (item) => item.id === "gcp_moq_relay" || item.id === "custom",
    );
  }
  return INGEST_ENDPOINTS.filter((item) => item.id !== "gcp_moq_relay");
}
