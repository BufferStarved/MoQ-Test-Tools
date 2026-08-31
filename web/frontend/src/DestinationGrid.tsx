import { useState } from "react";
import {
  gridIngestRoles,
  optionForHostCell,
  pickDestForHost,
  pickDestForRole,
  roleLabel,
  softwareLabel,
  unavailableDestLabel,
} from "./destinationGridModel";
import {
  ENCODE_HOSTS,
  cloudHostFromIngest,
  ingestCollisionKey,
  ingestRole,
  isCustomIngestEndpoint,
  type CloudEncodeHostId,
  type IngestEndpointOption,
} from "./ingestEndpoints";

const PROVIDERS = ["gcp", "linode", "aws"] as const;
const REGIONS = ["east", "central", "west"] as const;

const PROVIDER_LABEL: Record<(typeof PROVIDERS)[number], string> = {
  gcp: "GCP",
  linode: "Linode",
  aws: "AWS",
};

const REGION_LABEL: Record<(typeof REGIONS)[number], string> = {
  east: "East",
  central: "Central",
  west: "West",
};

export { preferredOptionForHost, softwareLabel } from "./destinationGridModel";

interface DestinationGridProps {
  outputIndex: number;
  selectedId: string;
  hostOptions: IngestEndpointOption[];
  protocol?: string;
  occupiedCollisionKeys?: ReadonlySet<string>;
  disabled?: boolean;
  hideCustom?: boolean;
  onSelect: (ingestEndpointId: string) => void;
}

export function DestinationGrid({
  outputIndex,
  selectedId,
  hostOptions,
  protocol = "",
  occupiedCollisionKeys = new Set(),
  disabled = false,
  hideCustom = false,
  onSelect,
}: DestinationGridProps) {
  const selectedHost = isCustomIngestEndpoint(selectedId)
    ? null
    : cloudHostFromIngest(selectedId);
  const occupied = (ingestEndpointId: string) => {
    const key = ingestCollisionKey(ingestEndpointId, protocol);
    return Boolean(key && occupiedCollisionKeys.has(key));
  };
  const westHasLive = ENCODE_HOSTS.some(
    (host) =>
      host.region === "west" &&
      hostOptions.some(
        (item) =>
          !isCustomIngestEndpoint(item.id) &&
          cloudHostFromIngest(item.id) === host.id &&
          item.available,
      ),
  );
  const westSelected = Boolean(selectedHost && selectedHost.endsWith("_west"));
  const [showWest, setShowWest] = useState(westSelected);
  const showWestCol = westHasLive || westSelected || showWest;
  const visibleRegions = REGIONS.filter((region) => region !== "west" || showWestCol);
  const ingestRoles = gridIngestRoles(hostOptions);
  const selectedRole = ingestRole(selectedId);

  return (
    <div className="destination-grid-wrap" data-testid="output-destination">
      {ingestRoles.length > 1 ? (
        <div className="destination-gateway" role="radiogroup" aria-label="Ingest gateway">
          <span className="destination-gateway-label">Ingest gateway</span>
          <span className="destination-gateway-hint">
            Zixi Broadcaster or MediaMTX — this is the ingest, not the region.
          </span>
          <div className="destination-gateway-seg">
            {ingestRoles.map((role) => {
              const item =
                hostOptions.find((opt) => ingestRole(opt.id) === role && opt.available) ??
                hostOptions.find((opt) => ingestRole(opt.id) === role);
              if (!item) {
                return null;
              }
              const freeId = pickDestForRole(role, hostOptions, occupied, selectedHost);
              const selected = selectedRole === role;
              return (
                <button
                  key={role}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`dest-role-${role}`}
                  className={selected ? "selected" : ""}
                  disabled={disabled || (!item.available && item.id !== selectedId) || (!freeId && !selected)}
                  onClick={() => {
                    if (freeId) {
                      onSelect(freeId);
                    }
                  }}
                >
                  {roleLabel(role)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <span className="field-label-with-icon destination-grid-label">Region</span>
      <div
        className="destination-grid"
        role="grid"
        aria-label={`Output ${outputIndex + 1} destination`}
        style={{ "--dest-cols": visibleRegions.length } as never}
      >
        <div className="destination-grid-corner" />
        {visibleRegions.map((region) => (
          <div key={region} className="destination-grid-colhead">
            {REGION_LABEL[region]}
          </div>
        ))}
        {PROVIDERS.map((provider) => (
          <DestinationProviderRow
            key={provider}
            provider={provider}
            selectedHost={selectedHost}
            selectedId={selectedId}
            hostOptions={hostOptions}
            occupied={occupied}
            disabled={disabled}
            regions={visibleRegions}
            onSelect={onSelect}
          />
        ))}
      </div>
      <div className="destination-grid-more-row">
        {!westHasLive && !westSelected ? (
          <button
            type="button"
            className="ghost-button destination-grid-more"
            onClick={() => setShowWest((open) => !open)}
          >
            {showWestCol ? "Hide empty West" : "More regions"}
          </button>
        ) : null}
      </div>
      {!hideCustom ? (
        <button
          type="button"
          className={`destination-cell destination-custom-cell${isCustomIngestEndpoint(selectedId) ? " selected" : ""}`}
          disabled={disabled}
          aria-pressed={isCustomIngestEndpoint(selectedId)}
          onClick={() => {
            const custom = hostOptions.find((item) => isCustomIngestEndpoint(item.id));
            if (custom) {
              onSelect(custom.id);
            }
          }}
        >
          <strong>Custom URL</strong>
          <span>Provide your own ingest endpoint.</span>
        </button>
      ) : null}
    </div>
  );
}

function DestinationProviderRow({
  provider,
  selectedHost,
  selectedId,
  hostOptions,
  occupied,
  disabled,
  regions,
  onSelect,
}: {
  provider: (typeof PROVIDERS)[number];
  selectedHost: CloudEncodeHostId | null;
  selectedId: string;
  hostOptions: IngestEndpointOption[];
  occupied: (ingestEndpointId: string) => boolean;
  disabled: boolean;
  regions: readonly (typeof REGIONS)[number][];
  onSelect: (ingestEndpointId: string) => void;
}) {
  const preferredRole = ingestRole(selectedId);
  return (
    <>
      <div className="destination-grid-rowhead">{PROVIDER_LABEL[provider]}</div>
      {regions.map((region) => {
        const host = ENCODE_HOSTS.find((item) => item.provider === provider && item.region === region);
        if (!host) {
          return <div key={`${provider}-${region}`} className="destination-cell empty" />;
        }
        const option = optionForHostCell(host.id, hostOptions, preferredRole, occupied);
        const selected = selectedHost === host.id;
        const taken = Boolean(option && occupied(option.id));
        const available = Boolean(option?.available) && !taken;
        const liveId = pickDestForHost(host.id, hostOptions, selectedId, occupied);
        const inUse = taken && !selected;
        return (
          <button
            key={host.id}
            type="button"
            role="gridcell"
            data-testid={`dest-cell-${host.id}`}
            className={`destination-cell${selected ? " selected" : ""}${available || selected ? "" : " unavailable"}`}
            disabled={disabled || (!liveId && !selected) || (inUse && !liveId)}
            title={
              option
                ? inUse
                  ? `${host.label} — ${unavailableDestLabel("In use by another output")}`
                  : available
                    ? `${host.label} · ${softwareLabel(option.id)}`
                    : `${host.label} — ${unavailableDestLabel(option.detail)}`
                : `${host.label} — Not available for this protocol`
            }
            aria-pressed={selected}
            onClick={() => {
              if (liveId) {
                onSelect(liveId);
              }
            }}
          >
            <strong>{option ? softwareLabel(option.id) : "—"}</strong>
            <span>
              {inUse
                ? unavailableDestLabel("In use by another output")
                : available
                  ? host.subtitle
                  : unavailableDestLabel(option?.detail)}
            </span>
          </button>
        );
      })}
    </>
  );
}
