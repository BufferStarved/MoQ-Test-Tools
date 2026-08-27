import { useState } from "react";
import { preferredOptionForHost, softwareLabel, unavailableDestLabel } from "./destinationGridModel";
import {
  ENCODE_HOSTS,
  cloudHostFromIngest,
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
  disabled?: boolean;
  hideCustom?: boolean;
  onSelect: (ingestEndpointId: string) => void;
}

export function DestinationGrid({
  outputIndex,
  selectedId,
  hostOptions,
  disabled = false,
  hideCustom = false,
  onSelect,
}: DestinationGridProps) {
  const selectedHost = isCustomIngestEndpoint(selectedId)
    ? null
    : cloudHostFromIngest(selectedId);
  const westHasLive = ENCODE_HOSTS.some(
    (host) =>
      host.region === "west" && Boolean(preferredOptionForHost(host.id, hostOptions)?.available),
  );
  const westSelected = Boolean(selectedHost && selectedHost.endsWith("_west"));
  const [showWest, setShowWest] = useState(westSelected);
  const showWestCol = westHasLive || westSelected || showWest;
  const visibleRegions = REGIONS.filter((region) => region !== "west" || showWestCol);

  const hostOptionsOnSelected = selectedHost
    ? hostOptions.filter(
        (item) => !isCustomIngestEndpoint(item.id) && cloudHostFromIngest(item.id) === selectedHost,
      )
    : [];

  return (
    <div className="destination-grid-wrap" data-testid="output-destination">
      <span className="field-label-with-icon destination-grid-label">Destination</span>
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
            hostOptions={hostOptions}
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
      {hostOptionsOnSelected.length > 1 ? (
        <div className="destination-role-alts" role="group" aria-label="Ingest software">
          {hostOptionsOnSelected.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`destination-role-chip${item.id === selectedId ? " selected" : ""}`}
              disabled={disabled || (!item.available && item.id !== selectedId)}
              onClick={() => onSelect(item.id)}
            >
              {item.available
                ? softwareLabel(item.id)
                : unavailableDestLabel(item.detail, softwareLabel(item.id))}
            </button>
          ))}
        </div>
      ) : null}
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
  hostOptions,
  disabled,
  regions,
  onSelect,
}: {
  provider: (typeof PROVIDERS)[number];
  selectedHost: CloudEncodeHostId | null;
  hostOptions: IngestEndpointOption[];
  disabled: boolean;
  regions: readonly (typeof REGIONS)[number][];
  onSelect: (ingestEndpointId: string) => void;
}) {
  return (
    <>
      <div className="destination-grid-rowhead">{PROVIDER_LABEL[provider]}</div>
      {regions.map((region) => {
        const host = ENCODE_HOSTS.find((item) => item.provider === provider && item.region === region);
        if (!host) {
          return <div key={`${provider}-${region}`} className="destination-cell empty" />;
        }
        const option = preferredOptionForHost(host.id, hostOptions);
        const selected = selectedHost === host.id;
        const available = Boolean(option?.available);
        const liveId = option?.id;
        return (
          <button
            key={host.id}
            type="button"
            role="gridcell"
            data-testid={`dest-cell-${host.id}`}
            className={`destination-cell${selected ? " selected" : ""}${available ? "" : " unavailable"}`}
            disabled={disabled || !liveId || (!available && !selected)}
            title={
              option
                ? available
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
            <strong>{liveId ? softwareLabel(liveId) : "—"}</strong>
            <span>
              {available
                ? host.subtitle
                : unavailableDestLabel(option?.detail)}
            </span>
          </button>
        );
      })}
    </>
  );
}
