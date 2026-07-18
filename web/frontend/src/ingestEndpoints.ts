export const INGEST_ENDPOINTS = [
  { id: "gcp_zixi", label: "Zixi Broadcaster gcp-us-central1", available: true },
  { id: "gcp_mediamtx", label: "MediaMTX gcp-us-central1 (LL-HLS / LL-DASH / WHEP)", available: true },
  { id: "gcp_moq_relay", label: "OpenMOQ MOQ-X gcp-us-central1", available: true },
  { id: "aws_zixi", label: "AWS Zixi", available: false },
  { id: "linode_zixi", label: "Linode Zixi", available: false },
  { id: "custom", label: "Custom URL", available: true },
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
