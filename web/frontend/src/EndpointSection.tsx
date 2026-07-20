import {
  defaultIngestForProtocol,
  ingestEndpointLabel,
  ingestEndpointsForProtocol,
  isCustomIngestEndpoint,
  presetIdForIngest,
} from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol } from "./types";
import {
  defaultPlaybackModeForProtocol,
  isManagedMoqRelay,
  managedEndpointUrlLabel,
  moqDefaultsFromPublishUrl,
  playbackModeLabelForSelection,
  relayWebTransportUrl,
  showMoqUrlFields,
} from "./playbackUrls";
import { protocolLabel } from "./protocolTheme";

/** Upload protocols not ready for benchmark comparisons yet. */
const UPLOAD_PROTOCOLS_COMING_SOON = new Set(["hls", "webrtc", "dash"]);

/** Per-protocol reason shown under the disabled protocol select. */
const UPLOAD_PROTOCOL_DISABLED_HINT: Partial<Record<string, string>> = {
  dash: (
    "Retired for now — Zixi's TS-over-HTTP push input reproducibly stops draining "
    + "the socket a couple seconds into a continuous live stream (confirmed independent "
    + "of this app), so DASH ingest silently produced frozen encodes. Use SRT or RTMP "
    + "ingest instead; we'll re-enable this once Zixi confirms sustained live TS push support."
  ),
};
const DEFAULT_PROTOCOL_DISABLED_HINT =
  "This upload protocol is coming soon and is not available for comparisons yet.";
/** Option suffix — "retired" for protocols we turned off deliberately, "coming soon" otherwise. */
const UPLOAD_PROTOCOL_DISABLED_SUFFIX: Partial<Record<string, string>> = {
  dash: " (retired)",
};
const DEFAULT_PROTOCOL_DISABLED_SUFFIX = " (coming soon)";

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

function playerShortLabel(endpoint: EndpointConfig): string {
  const mode = endpoint.playbackMode ?? defaultPlaybackModeForProtocol(
    endpoint.protocol,
    endpoint.ingestEndpointId,
  );
  return playbackModeLabelForSelection(
    mode === "auto"
      ? defaultPlaybackModeForProtocol(endpoint.protocol, endpoint.ingestEndpointId)
      : mode,
    endpoint.protocol,
    endpoint.ingestEndpointId,
  );
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
  const hostOptions = ingestEndpointsForProtocol(endpoint.protocol);
  const selectedIngest = hostOptions.find((item) => item.id === endpoint.ingestEndpointId)
    ?? hostOptions[0];
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

      <p className="stream-path-chips" aria-label="Publish path">
        <span>{protocolLabel(endpoint.protocol)}</span>
        <span className="stream-path-sep" aria-hidden="true">
          →
        </span>
        <span>{ingestEndpointLabel(endpoint.ingestEndpointId)}</span>
        <span className="stream-path-sep" aria-hidden="true">
          →
        </span>
        <span>{playerShortLabel(endpoint)}</span>
      </p>

      <label>
        Protocol
        <select
          value={endpoint.protocol}
          onChange={(e) => {
            const protocol = e.target.value;
            if (UPLOAD_PROTOCOLS_COMING_SOON.has(protocol)) {
              return;
            }
            const nextIngest = defaultIngestForProtocol(protocol);
            const patch: Partial<EndpointConfig> = {
              protocol,
              ingestEndpointId: nextIngest,
              playbackMode: defaultPlaybackModeForProtocol(protocol, nextIngest),
            };
            if (protocol === "moq") {
              Object.assign(
                patch,
                moqPatchFromPreset({ ...endpoint, protocol, ingestEndpointId: nextIngest }, presets),
              );
            }
            onChange(endpoint.id, patch);
          }}
          disabled={controlsLocked}
        >
          {protocols.map((item) => {
            const comingSoon = UPLOAD_PROTOCOLS_COMING_SOON.has(item.id);
            return (
              <option key={item.id} value={item.id} disabled={comingSoon}>
                {item.label}
                {comingSoon
                  ? UPLOAD_PROTOCOL_DISABLED_SUFFIX[item.id] ?? DEFAULT_PROTOCOL_DISABLED_SUFFIX
                  : ""}
              </option>
            );
          })}
        </select>
        {UPLOAD_PROTOCOLS_COMING_SOON.has(endpoint.protocol) && (
          <span className="hint">
            {UPLOAD_PROTOCOL_DISABLED_HINT[endpoint.protocol] ?? DEFAULT_PROTOCOL_DISABLED_HINT}
          </span>
        )}
      </label>

      <label>
        Host / ingest
        <select
          value={
            hostOptions.some((item) => item.id === endpoint.ingestEndpointId)
              ? endpoint.ingestEndpointId
              : (hostOptions[0]?.id ?? endpoint.ingestEndpointId)
          }
          onChange={(e) => {
            const ingestEndpointId = e.target.value;
            const patch: Partial<EndpointConfig> = {
              ingestEndpointId,
              playbackMode: defaultPlaybackModeForProtocol(endpoint.protocol, ingestEndpointId),
            };
            if (endpoint.protocol === "moq" && isManagedMoqRelay(ingestEndpointId)) {
              Object.assign(patch, moqPatchFromPreset({ ...endpoint, ingestEndpointId }, presets));
            }
            onChange(endpoint.id, patch);
          }}
          disabled={controlsLocked}
        >
          {hostOptions.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.available}>
              {item.label}
              {!item.available ? " (coming soon)" : ""}
            </option>
          ))}
        </select>
        {selectedIngest?.detail && selectedIngest.available && (
          <span className="field-hint">{selectedIngest.detail}</span>
        )}
        {selectedIngest && !selectedIngest.available && (
          <span className="hint">This host is not configured yet.</span>
        )}
      </label>

      {isCustom && (
        <label>
          Publish URL
          <input
            type="url"
            value={endpoint.endpointUrl}
            onChange={(e) => onChange(endpoint.id, { endpointUrl: e.target.value })}
            placeholder={protocolMeta?.syntax ?? "Enter publish URL"}
          />
        </label>
      )}

      {managedUrl && (
        <p className="hint managed-endpoint-url">
          <span className="url-field-label">{managedLabel}</span>
          <code>{managedUrl}</code>
        </p>
      )}

      {showMoq && (
        <>
          <label>
            MoQ Publish URL
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
