import { useState } from "react";
import { preferredOptionForHost, softwareLabel } from "./destinationGridModel";
import {
  ENCODE_HOSTS,
  cloudHostFromIngest,
  encodeHostProvider,
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
  const selectedProvider = selectedHost ? encodeHostProvider(selectedHost) : null;
  const awsHosts = ENCODE_HOSTS.filter((host) => host.provider === "aws");
  const awsHasLive = awsHosts.some((host) => preferredOptionForHost(host.id, hostOptions)?.available);
  const awsSelected = selectedProvider === "aws";
  const [showAws, setShowAws] = useState(awsSelected);
  const showAwsRow = awsHasLive || awsSelected || showAws;

  const hostOptionsOnSelected = selectedHost
    ? hostOptions.filter(
        (item) => !isCustomIngestEndpoint(item.id) && cloudHostFromIngest(item.id) === selectedHost,
      )
    : [];

  return (
    <div className="destination-grid-wrap" data-testid="output-destination">
      <span className="field-label-with-icon destination-grid-label">Destination</span>
      <div className="destination-grid" role="grid" aria-label={`Output ${outputIndex + 1} destination`}>
        <div className="destination-grid-corner" />
        {REGIONS.map((region) => (
          <div key={region} className="destination-grid-colhead">
            {REGION_LABEL[region]}
          </div>
        ))}
        {PROVIDERS.map((provider) => {
          if (provider === "aws" && !showAwsRow) {
            return null;
          }
          return (
            <DestinationProviderRow
              key={provider}
              provider={provider}
              selectedId={selectedId}
              selectedHost={selectedHost}
              hostOptions={hostOptions}
              disabled={disabled}
              onSelect={onSelect}
            />
          );
        })}
      </div>
      {!awsHasLive && !awsSelected ? (
        <button
          type="button"
          className="ghost-button destination-grid-more"
          onClick={() => setShowAws((open) => !open)}
        >
          {showAwsRow ? "Hide undeployed AWS" : "Show undeployed AWS"}
        </button>
      ) : null}
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
              {softwareLabel(item.id)}
              {!item.available ? " · grey" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {!hideCustom ? (
        <label className={`destination-custom-row${isCustomIngestEndpoint(selectedId) ? " selected" : ""}`}>
          <input
            type="radio"
            name={`output-dest-custom-${outputIndex}`}
            checked={isCustomIngestEndpoint(selectedId)}
            disabled={disabled}
            onChange={() => {
              const custom = hostOptions.find((item) => isCustomIngestEndpoint(item.id));
              if (custom) {
                onSelect(custom.id);
              }
            }}
          />
          Custom URL
        </label>
      ) : null}
    </div>
  );
}

function DestinationProviderRow({
  provider,
  selectedId,
  selectedHost,
  hostOptions,
  disabled,
  onSelect,
}: {
  provider: (typeof PROVIDERS)[number];
  selectedId: string;
  selectedHost: CloudEncodeHostId | null;
  hostOptions: IngestEndpointOption[];
  disabled: boolean;
  onSelect: (ingestEndpointId: string) => void;
}) {
  return (
    <>
      <div className="destination-grid-rowhead">{PROVIDER_LABEL[provider]}</div>
      {REGIONS.map((region) => {
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
                  : `${host.label} — Not deployed`
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
            <span>{available ? host.subtitle : "Not deployed"}</span>
          </button>
        );
      })}
    </>
  );
}
