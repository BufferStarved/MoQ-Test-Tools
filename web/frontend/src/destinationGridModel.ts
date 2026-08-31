import {
  cloudHostFromIngest,
  ingestRole,
  isCustomIngestEndpoint,
  remapIngestToCloudHost,
  type CloudEncodeHostId,
  type IngestEndpointOption,
} from "./ingestEndpoints.ts";

const ROLE_LABEL: Record<string, string> = {
  zixi: "Zixi",
  mediamtx: "MediaMTX",
  moq_relay: "MoQ",
};

const ROLE_ORDER = ["zixi", "mediamtx", "moq_relay"] as const;

export function softwareLabel(ingestEndpointId: string): string {
  return ROLE_LABEL[ingestRole(ingestEndpointId) ?? ""] || "Ingest";
}

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] || role;
}

/** Chip / cell copy when a dest is not startable. */
export function unavailableDestLabel(detail: string | undefined, software?: string): string {
  const note = (detail || "").toLowerCase();
  if (/in use|occupied|another output/.test(note)) {
    return software ? `${software} (in use)` : "In use";
  }
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

function optionsOnHost(
  hostId: CloudEncodeHostId,
  hostOptions: IngestEndpointOption[],
): IngestEndpointOption[] {
  return hostOptions.filter(
    (item) => !isCustomIngestEndpoint(item.id) && cloudHostFromIngest(item.id) === hostId,
  );
}

/**
 * Cell to paint for a host. Prefer the output's current ingest role (Zixi vs
 * MediaMTX) so SRT + Zixi shows every deployed Zixi region, not MediaMTX in
 * every cell. Occupied dests stay visible as "in use"; undeployed Zixi falls
 * through to MediaMTX when that box is live (Dallas / Fremont).
 */
export function optionForHostCell(
  hostId: CloudEncodeHostId,
  hostOptions: IngestEndpointOption[],
  preferredRole: string | null,
  occupied: (ingestEndpointId: string) => boolean,
): IngestEndpointOption | undefined {
  const onHost = optionsOnHost(hostId, hostOptions);
  if (!onHost.length) {
    return undefined;
  }
  const roleMatches = preferredRole
    ? onHost.filter((item) => ingestRole(item.id) === preferredRole)
    : [];
  const preferredLive = roleMatches.find((item) => item.available && !occupied(item.id));
  if (preferredLive) {
    return preferredLive;
  }
  const preferredTaken = roleMatches.find((item) => item.available && occupied(item.id));
  if (preferredTaken) {
    return preferredTaken;
  }
  const live = onHost.find((item) => item.available && !occupied(item.id));
  if (live) {
    return live;
  }
  const taken = onHost.find((item) => item.available && occupied(item.id));
  if (taken) {
    return taken;
  }
  return onHost[0];
}

/** Ingest roles that have at least one deployed dest in this protocol list. */
export function gridIngestRoles(hostOptions: IngestEndpointOption[]): string[] {
  return ROLE_ORDER.filter((role) =>
    hostOptions.some((item) => ingestRole(item.id) === role && item.available),
  );
}

export function pickDestForRole(
  role: string,
  hostOptions: IngestEndpointOption[],
  occupied: (ingestEndpointId: string) => boolean,
  preferHost: CloudEncodeHostId | null,
): string | undefined {
  const matches = hostOptions.filter(
    (item) => !isCustomIngestEndpoint(item.id) && ingestRole(item.id) === role && item.available,
  );
  const free = matches.filter((item) => !occupied(item.id));
  if (preferHost) {
    const same = free.find((item) => cloudHostFromIngest(item.id) === preferHost);
    if (same) {
      return same.id;
    }
  }
  return free[0]?.id;
}

export function pickDestForHost(
  hostId: CloudEncodeHostId,
  hostOptions: IngestEndpointOption[],
  selectedId: string,
  occupied: (ingestEndpointId: string) => boolean,
): string | undefined {
  if (!isCustomIngestEndpoint(selectedId)) {
    const remapped = remapIngestToCloudHost(selectedId, hostId);
    const remappedOpt = hostOptions.find((item) => item.id === remapped);
    if (remappedOpt?.available && !occupied(remappedOpt.id)) {
      return remappedOpt.id;
    }
  }
  const cell = optionForHostCell(hostId, hostOptions, ingestRole(selectedId), occupied);
  if (cell?.available && !occupied(cell.id)) {
    return cell.id;
  }
  return undefined;
}
