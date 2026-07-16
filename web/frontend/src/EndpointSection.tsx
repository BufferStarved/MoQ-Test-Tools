import { INGEST_ENDPOINTS, isCustomIngestEndpoint, presetIdForIngest } from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol } from "./types";
import {
  defaultPlaybackModeForProtocol,
  isManagedMoqRelay,
  managedEndpointUrlLabel,
  moqDefaultsFromPublishUrl,
  relayWebTransportUrl,
  showMoqUrlFields,
} from "./playbackUrls";

interface EndpointSectionProps {
  index: number;
  endpoint: EndpointConfig;
  protocols: Protocol[];
  presets: Preset[];
  bootstrapping: boolean;
  apiOnline: boolean;
  canRemove: boolean;
  onChange: (id: string, patch: Partial<EndpointConfig>) => void;
  onRemove: (id: string) => void;
}

function resolvePresetUrl(endpoint: EndpointConfig, presets: Preset[]): string {
  const presetId = presetIdForIngest(endpoint.ingestEndpointId, endpoint.protocol);
  if (!presetId) {
    return "";
  }
  return presets.find((preset) => preset.id === presetId)?.url?.trim() ?? "";
}

function moqPatchFromPreset(endpoint: EndpointConfig, presets: Preset[]): Partial<EndpointConfig> {
  const publishUrl = resolvePresetUrl(endpoint, presets);
  if (!publishUrl) {
    return { moqNamespace: "benchmark" };
  }
  const defaults = moqDefaultsFromPublishUrl(publishUrl);
  return {
    moqRelayUrl: defaults.webTransportUrl,
    moqNamespace: defaults.namespace,
    moqFingerprintUrl: defaults.fingerprintUrl,
  };
}

function managedDisplayUrl(endpoint: EndpointConfig, presets: Preset[]): string {
  const publishUrl = resolvePresetUrl(endpoint, presets);
  if (!publishUrl) {
    return "";
  }
  if (endpoint.protocol === "moq") {
    return moqDefaultsFromPublishUrl(publishUrl).webTransportUrl || relayWebTransportUrl(publishUrl);
  }
  return publishUrl;
}

export function EndpointSection({
  index,
  endpoint,
  protocols,
  presets,
  bootstrapping,
  apiOnline,
  canRemove,
  onChange,
  onRemove,
}: EndpointSectionProps) {
  const protocolMeta = protocols.find((item) => item.id === endpoint.protocol);
  const selectedIngest = INGEST_ENDPOINTS.find((item) => item.id === endpoint.ingestEndpointId);
  const isCustom = isCustomIngestEndpoint(endpoint.ingestEndpointId);
  const showMoq = showMoqUrlFields(endpoint.playbackMode, endpoint.protocol, endpoint.ingestEndpointId);
  const managedUrl = !isCustom ? managedDisplayUrl(endpoint, presets) : "";
  const managedLabel = managedEndpointUrlLabel(endpoint.protocol);

  const controlsLocked = bootstrapping || !apiOnline;

  return (
    <div className="endpoint-section">
      {controlsLocked && (
        <p className="hint endpoint-lock-hint">
          {bootstrapping
            ? "Loading protocol and preset options from the API..."
            : "Controls are locked until the API is reachable."}
        </p>
      )}
      <div className="endpoint-header">
        <h3>Stream {index + 1}</h3>
        {canRemove && (
          <button type="button" className="ghost-button" onClick={() => onRemove(endpoint.id)}>
            Remove
          </button>
        )}
      </div>

      <label>
        Protocol
        <select
          value={endpoint.protocol}
          onChange={(e) => {
            const protocol = e.target.value;
            const patch: Partial<EndpointConfig> = {
              protocol,
              playbackMode: defaultPlaybackModeForProtocol(protocol),
            };
            if (protocol === "moq") {
              patch.ingestEndpointId = "gcp_moq_relay";
              Object.assign(
                patch,
                moqPatchFromPreset({ ...endpoint, protocol, ingestEndpointId: "gcp_moq_relay" }, presets),
              );
            } else if (endpoint.ingestEndpointId === "gcp_moq_relay") {
              patch.ingestEndpointId = "gcp_zixi";
            }
            onChange(endpoint.id, patch);
          }}
          disabled={controlsLocked}
        >
          {protocols.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Ingest Endpoint
        <select
          value={endpoint.ingestEndpointId}
          onChange={(e) => {
            const ingestEndpointId = e.target.value;
            const patch: Partial<EndpointConfig> = { ingestEndpointId };
            if (endpoint.protocol === "moq" && isManagedMoqRelay(ingestEndpointId)) {
              Object.assign(patch, moqPatchFromPreset({ ...endpoint, ingestEndpointId }, presets));
            }
            onChange(endpoint.id, patch);
          }}
          disabled={controlsLocked}
        >
          {INGEST_ENDPOINTS.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.available}>
              {item.label}
              {!item.available ? " (coming soon)" : ""}
            </option>
          ))}
        </select>
        {selectedIngest && !selectedIngest.available && (
          <span className="hint">This ingest endpoint is not configured yet.</span>
        )}
      </label>

      {isCustom && (
        <label>
          Endpoint URL
          <input
            type="url"
            value={endpoint.endpointUrl}
            onChange={(e) => onChange(endpoint.id, { endpointUrl: e.target.value })}
            placeholder={protocolMeta?.syntax ?? "Enter endpoint URL"}
          />
        </label>
      )}

      {managedUrl && (
        <p className="hint managed-endpoint-url">
          {managedLabel} <code>{managedUrl}</code>
        </p>
      )}

      {showMoq && (
        <>
          <label>
            MoQ relay URL
            <input
              type="url"
              value={endpoint.moqRelayUrl ?? ""}
              onChange={(e) => onChange(endpoint.id, { moqRelayUrl: e.target.value })}
              placeholder="https://relay.example.com:4433"
              disabled={controlsLocked}
            />
          </label>
          <label>
            MoQ namespace
            <input
              type="text"
              value={endpoint.moqNamespace ?? ""}
              onChange={(e) => onChange(endpoint.id, { moqNamespace: e.target.value })}
              placeholder="benchmark"
              disabled={controlsLocked}
            />
          </label>
          <label>
            MoQ fingerprint URL (optional)
            <input
              type="url"
              value={endpoint.moqFingerprintUrl ?? ""}
              onChange={(e) => onChange(endpoint.id, { moqFingerprintUrl: e.target.value })}
              placeholder="https://relay.example.com:4433/fingerprint"
              disabled={controlsLocked}
            />
          </label>
        </>
      )}
    </div>
  );
}
