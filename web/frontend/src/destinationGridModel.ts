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

/** Chip / cell copy when a dest is not startable. */
export function unavailableDestLabel(detail: string | undefined, software?: string): string {
  const note = (detail || "").toLowerCase();
  const down = /down|frozen|unreachable|dead/.test(note);
  if (down) {
    return software ? `${software} (this box is down)` : "This box is down";
  }
  return software ? `${software} — not deployed` : "Not deployed";
}

export function preferredOptionForHost(
  hostId: CloudEncodeHostId,
  hostOptions: IngestEndpointOption[],
): IngestEndpointOption | undefined {
  return hostOptions.find(
    (item) => !isCustomIngestEndpoint(item.id) && cloudHostFromIngest(item.id) === hostId,
  );
}
