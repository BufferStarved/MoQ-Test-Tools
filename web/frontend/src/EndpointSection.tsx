import {
  cloudHostFromIngest,
  defaultIngestForProtocol,
  ingestEndpointLabel,
  ingestEndpointsForProtocol,
  isCustomIngestEndpoint,
  presetIdForIngest,
} from "./ingestEndpoints";
import type { EndpointConfig, Preset, Protocol } from "./types";
import type { PlaybackMode } from "./playbackTypes";
import { IconBroadcast, IconMonitor, IconTarget } from "./Icons";
import {
  defaultWhepPlaybackUrl,
  isManagedMoqRelay,
  managedEndpointUrlLabel,
  moqDefaultsFromPublishUrl,
  playbackModeBlockedReason,
  playbackModeLabelForSelection,
  playbackModesForSelection,
  relayWebTransportUrl,
  resolvedPlaybackMode,
  showMoqUrlFields,
} from "./playbackUrls";
import { protocolLabel } from "./protocolTheme";

/** Upload protocols not ready for benchmark comparisons yet. */
const UPLOAD_PROTOCOLS_COMING_SOON = new Set(["hls", "dash"]);

interface EndpointSectionProps {
  index: number;
  endpoint: EndpointConfig;
  protocols: Protocol[];
  presets: Preset[];
  bootstrapping: boolean;
  apiOnline: boolean;
  canRemove: boolean;
  /** Browser source publishes MoQ and WebRTC (WHIP) only. */
  browserPublish?: boolean;
  onChange: (id: string, patch: Partial<EndpointConfig>) => void;
  onRemove: (id: string) => void;
}

function parseHostSafe(endpointUrl: string): string | null {
  try {
    if (endpointUrl.startsWith("srt://") || endpointUrl.startsWith("rtmp://")) {
      const withoutScheme = endpointUrl.split("://")[1] ?? "";
      const hostPart = withoutScheme.split(/[/?]/)[0] ?? "";
      return hostPart.split(":")[0] || null;
    }
    return new URL(endpointUrl).hostname || null;
  } catch {
    return null;
  }
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

export function playerShortLabel(endpoint: EndpointConfig): string {
  const mode = resolvedPlaybackMode(
    endpoint.playbackMode,
    endpoint.protocol,
    endpoint.ingestEndpointId,
  );
  return playbackModeLabelForSelection(
    mode,
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
  browserPublish = false,
  onChange,
  onRemove,
}: EndpointSectionProps) {
  const protocolMeta = protocols.find((item) => item.id === endpoint.protocol);
  const hostOptions = ingestEndpointsForProtocol(endpoint.protocol, presets);
  const selectedIngest =
    hostOptions.find((item) => item.id === endpoint.ingestEndpointId) ??
    hostOptions.find((item) => item.available) ??
    hostOptions[0];
  const isCustom = isCustomIngestEndpoint(endpoint.ingestEndpointId);
  const showMoq = showMoqUrlFields(endpoint.playbackMode, endpoint.protocol, endpoint.ingestEndpointId);
  const managedUrl = !isCustom ? managedDisplayUrl(endpoint, presets) : "";
  const managedLabel = managedEndpointUrlLabel(endpoint.protocol);
  const playerModes = playbackModesForSelection(endpoint.protocol, endpoint.ingestEndpointId);
  const resolvedMode = resolvedPlaybackMode(
    endpoint.playbackMode,
    endpoint.protocol,
    endpoint.ingestEndpointId,
  );
  const showWhepField = resolvedMode === "whep";
  const whepPlaceholder = defaultWhepPlaybackUrl(
    parseHostSafe(endpoint.endpointUrl) ?? "34.9.217.178",
    "benchmark",
  );

  const controlsLocked = bootstrapping || !apiOnline;
  const liveProtocols = protocols
    .filter((item) => !UPLOAD_PROTOCOLS_COMING_SOON.has(item.id))
    .filter((item) => !browserPublish || item.id === "moq" || item.id === "webrtc");

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
        <h3>Output {index + 1}</h3>
        {canRemove && (
          <button type="button" className="ghost-button" onClick={() => onRemove(endpoint.id)}>
            Remove
          </button>
        )}
      </div>

      {liveProtocols.length <= 1 ? (
        <p className="endpoint-static-field">
          <span className="field-label-with-icon">
            <IconBroadcast size={14} /> Protocol
          </span>
          <strong>{protocolLabel(endpoint.protocol)}</strong>
        </p>
      ) : (
        <label>
          <span className="field-label-with-icon">
            <IconBroadcast size={14} /> Protocol
          </span>
          <select
            value={endpoint.protocol}
            onChange={(e) => {
              const protocol = e.target.value;
              if (UPLOAD_PROTOCOLS_COMING_SOON.has(protocol) || (browserPublish && protocol !== "moq" && protocol !== "webrtc")) {
                return;
              }
              const nextIngest = defaultIngestForProtocol(
                protocol,
                cloudHostFromIngest(endpoint.ingestEndpointId),
              );
              const patch: Partial<EndpointConfig> = {
                protocol,
                ingestEndpointId: nextIngest,
                playbackMode: resolvedPlaybackMode(undefined, protocol, nextIngest),
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
            {liveProtocols.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        <span className="field-label-with-icon">
          <IconTarget size={14} /> Destination
        </span>
        <select
          value={
            hostOptions.some((item) => item.id === endpoint.ingestEndpointId)
              ? endpoint.ingestEndpointId
              : (hostOptions.find((item) => item.available)?.id ??
                hostOptions[0]?.id ??
                endpoint.ingestEndpointId)
          }
          onChange={(e) => {
            const ingestEndpointId = e.target.value;
            const patch: Partial<EndpointConfig> = {
              ingestEndpointId,
              playbackMode: resolvedPlaybackMode(undefined, endpoint.protocol, ingestEndpointId),
            };
            if (endpoint.protocol === "moq" && isManagedMoqRelay(ingestEndpointId)) {
              Object.assign(patch, moqPatchFromPreset({ ...endpoint, ingestEndpointId }, presets));
            }
            onChange(endpoint.id, patch);
          }}
          disabled={controlsLocked}
        >
          {hostOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
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

      {playerModes.length <= 1 ? (
        <p className="endpoint-static-field">
          <span className="field-label-with-icon">
            <IconMonitor size={14} /> Player
          </span>
          <strong>
            {playbackModeLabelForSelection(resolvedMode, endpoint.protocol, endpoint.ingestEndpointId)}
          </strong>
        </p>
      ) : (
        <>
          <label>
            <span className="field-label-with-icon">
              <IconMonitor size={14} /> Player
            </span>
            <select
              value={resolvedMode}
              onChange={(e) => onChange(endpoint.id, { playbackMode: e.target.value as PlaybackMode })}
              disabled={controlsLocked}
            >
              {playerModes.map((item) => {
                const blocked = playbackModeBlockedReason(
                  item.id,
                  endpoint.protocol,
                  endpoint.ingestEndpointId,
                );
                return (
                  <option key={item.id} value={item.id} disabled={Boolean(blocked)} title={blocked}>
                    {playbackModeLabelForSelection(item.id, endpoint.protocol, endpoint.ingestEndpointId)}
                  </option>
                );
              })}
            </select>
          </label>
          {playbackModeBlockedReason("hls", endpoint.protocol, endpoint.ingestEndpointId) ? (
            <p className="field-hint">
              Fast HLS is disabled for Zixi SRT — the packager playlist stalls. MPEG-TS is the working player.
            </p>
          ) : null}
        </>
      )}

      {showWhepField && (
        <label>
          WHEP Playback URL
          <input
            type="url"
            value={endpoint.whepPlaybackUrl ?? ""}
            onChange={(e) => onChange(endpoint.id, { whepPlaybackUrl: e.target.value })}
            placeholder={whepPlaceholder}
            disabled={controlsLocked}
          />
        </label>
      )}

      {(managedUrl || showMoq) && (
        <details className="output-advanced">
          <summary>Advanced</summary>
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
        </details>
      )}
    </div>
  );
}
