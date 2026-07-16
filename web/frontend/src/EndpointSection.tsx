import { INGEST_ENDPOINTS, isCustomIngestEndpoint, presetIdForIngest } from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol } from "./types";
import type { PlaybackMode } from "./playbackTypes";
import {
  PLAYBACK_MODE_OPTIONS,
  defaultWhepPlaybackUrl,
  isManagedMoqRelay,
  moqDefaultsFromPublishUrl,
  showMoqUrlFields,
  showWhepUrlField,
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
  const playbackMode = endpoint.playbackMode ?? "auto";
  const showWhep = showWhepUrlField(playbackMode, endpoint.protocol);
  const showMoq = showMoqUrlFields(playbackMode, endpoint.protocol, endpoint.ingestEndpointId);
  const managedMoq = endpoint.protocol === "moq" && isManagedMoqRelay(endpoint.ingestEndpointId);
  const managedMoqDefaults = managedMoq ? moqDefaultsFromPublishUrl(resolvePresetUrl(endpoint, presets)) : null;
  const whepPlaceholder =
    endpoint.protocol === "srt"
      ? defaultWhepPlaybackUrl("35.222.33.58", "benchmark")
      : "http://host:8080/whep/benchmark";

  const controlsLocked = bootstrapping || !apiOnline;

  return (
    <div className="endpoint-section">
      {controlsLocked && (
        <p className="hint endpoint-lock-hint">
          {bootstrapping
            ? "Loading protocol and preset options from the API..."
            : "Controls are locked until the API is reachable. Use http://127.0.0.1:5173 after ./scripts/dev.sh, then click Retry if needed."}
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
            const patch: Partial<EndpointConfig> = { protocol };
            if (protocol === "moq") {
              patch.ingestEndpointId = "gcp_moq_relay";
              patch.playbackMode = "moq";
              Object.assign(
                patch,
                moqPatchFromPreset({ ...endpoint, protocol, ingestEndpointId: "gcp_moq_relay" }, presets),
              );
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
        Ingest endpoint
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

      <label>
        Playback
        <select
          value={endpoint.playbackMode ?? "auto"}
          onChange={(e) => onChange(endpoint.id, { playbackMode: e.target.value as PlaybackMode })}
          disabled={controlsLocked}
        >
          {PLAYBACK_MODE_OPTIONS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <span className="hint">
          {PLAYBACK_MODE_OPTIONS.find((item) => item.id === (endpoint.playbackMode ?? "auto"))?.hint}
        </span>
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={endpoint.playbackDvr ?? false}
          onChange={(e) => onChange(endpoint.id, { playbackDvr: e.target.checked })}
          disabled={controlsLocked}
        />
        <span>Enable DVR playlist (HLS/DASH when available)</span>
      </label>

      {managedMoq && managedMoqDefaults?.relayUrl && (
        <div className="managed-playback-summary">
          <p className="hint">
            MoQ playback is configured automatically from the GCP MoQ relay preset. You do not need to
            fill in relay, namespace, or fingerprint fields.
          </p>
          <dl className="managed-playback-values">
            <div>
              <dt>WebTransport URL</dt>
              <dd>
                <code>{managedMoqDefaults.webTransportUrl}</code>
              </dd>
            </div>
            <div>
              <dt>Namespace</dt>
              <dd>
                <code>{managedMoqDefaults.namespace}</code>
              </dd>
            </div>
            <div>
              <dt>Fingerprint URL</dt>
              <dd>
                <code>{managedMoqDefaults.fingerprintUrl}</code>
              </dd>
            </div>
          </dl>
        </div>
      )}

      {showWhep && (
        <label>
          WHEP channel URL
          <input
            type="url"
            value={endpoint.whepPlaybackUrl ?? ""}
            onChange={(e) => onChange(endpoint.id, { whepPlaybackUrl: e.target.value })}
            placeholder={whepPlaceholder}
            disabled={controlsLocked}
          />
          <span className="hint">
            WebRTC preview endpoint from a WHEP gateway (e.g. Eyevinn srt-whep). Auto mode uses WHEP
            for SRT when this is set; otherwise falls back to Zixi HLS.
          </span>
        </label>
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
            <span className="hint">
              Only needed for custom MoQ relays. Managed GCP MoQ relay fills these in automatically.
            </span>
          </label>
        </>
      )}
    </div>
  );
}
