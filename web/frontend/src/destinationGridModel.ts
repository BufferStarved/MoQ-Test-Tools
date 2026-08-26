import {
  cloudHostFromIngest,
  ingestRole,
  isCustomIngestEndpoint,
  type CloudEncodeHostId,
  type IngestEndpointOption,
} from "./ingestEndpoints.ts";

const ROLE_LABEL: Record<string, string> = {
  zixi: "Zixi",
  mediamtx: "MediaMTX",
  moq_relay: "MoQ",
};

export function softwareLabel(ingestEndpointId: string): string {
  return ROLE_LABEL[ingestRole(ingestEndpointId) ?? ""] || "Ingest";
}

export function preferredOptionForHost(
  hostId: CloudEncodeHostId,
  hostOptions: IngestEndpointOption[],
): IngestEndpointOption | undefined {
  return hostOptions.find(
    (item) => !isCustomIngestEndpoint(item.id) && cloudHostFromIngest(item.id) === hostId,
  );
}
