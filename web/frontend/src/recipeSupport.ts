/**
 * Single source of truth for which recipes the web UI may assemble.
 * Protocol × ingest × player × source × browser gates all go through here
 * so dropdowns, Add output, and Start cannot retain an unsupported combo.
 */
import {
  cloudHostFromIngest,
  collapseOutputsForBrowserMoq,
  defaultIngestForProtocol,
  ingestCollisionKey,
  ingestEndpointsForProtocol,
  ingestRole,
  isCustomIngestEndpoint,
  type IngestEndpointId,
} from "./ingestEndpoints";
import {
  isPlaybackModeCompatible,
  playbackModesForSelection,
  resolvedPlaybackMode,
} from "./playbackUrls";
import type { PlaybackMode } from "./playbackTypes";
import type { EndpointConfig, Preset } from "./types";

export const PUBLISH_PROTOCOL_IDS = ["srt", "rtmp", "webrtc", "moq"] as const;
export type PublishProtocolId = (typeof PUBLISH_PROTOCOL_IDS)[number];

export interface RecipeBrowserCaps {
  safari: boolean;
  webTransport: boolean;
  rtcPeerConnection: boolean;
}

export const RECIPE_CHROME_CAPS: RecipeBrowserCaps = {
  safari: false,
  webTransport: true,
  rtcPeerConnection: true,
};

export type RecipeSourceId = "dummy" | "bbb" | "upload" | "webcam" | "browser_moq";

export interface RecipePublisherCaps {
  /**
   * Laptop ffmpeg can mux `-f whip`. Webcam / This-machine recipes must
   * not offer WebRTC without this — cloud and in-browser WHIP do not
   * use the laptop muxer.
   */
  localFfmpegWhip: boolean;
}

export const RECIPE_CLOUD_PUBLISHER: RecipePublisherCaps = { localFfmpegWhip: true };

export interface RecipeContext {
  source: RecipeSourceId;
  presets: Preset[];
  caps: RecipeBrowserCaps;
  publisher?: RecipePublisherCaps;
}

export function recipePublisherCaps(ctx: Pick<RecipeContext, "publisher">): RecipePublisherCaps {
  return ctx.publisher ?? RECIPE_CLOUD_PUBLISHER;
}

function isPublishProtocol(protocol: string): protocol is PublishProtocolId {
  return (PUBLISH_PROTOCOL_IDS as readonly string[]).includes(protocol);
}

export function protocolAllowedInBrowser(protocol: string, caps: RecipeBrowserCaps): boolean {
  if (protocol === "moq") {
    return caps.webTransport && !caps.safari;
  }
  if (protocol === "webrtc") {
    return caps.rtcPeerConnection;
  }
  return protocol === "srt" || protocol === "rtmp";
}

export function publishProtocolIdsForSource(
  source: RecipeSourceId,
  caps: RecipeBrowserCaps,
  publisher: RecipePublisherCaps = RECIPE_CLOUD_PUBLISHER,
): PublishProtocolId[] {
  const live: PublishProtocolId[] =
    source === "browser_moq" ? ["moq", "webrtc"] : ["srt", "rtmp", "webrtc", "moq"];
  return live.filter((protocol) => {
    if (!protocolAllowedInBrowser(protocol, caps)) {
      return false;
    }
    // Webcam encode is the local agent. No WHIP muxer → no WebRTC option.
    if (protocol === "webrtc" && source === "webcam" && !publisher.localFfmpegWhip) {
      return false;
    }
    return true;
  });
}

export function playbackModeAllowedInBrowser(
  mode: PlaybackMode,
  caps: RecipeBrowserCaps,
): boolean {
  if (mode === "moq") {
    return caps.webTransport && !caps.safari;
  }
  if (mode === "whep") {
    return caps.rtcPeerConnection;
  }
  if (caps.safari) {
    return mode === "hls" || mode === "ll-hls";
  }
  return true;
}

export function selectablePlaybackModes(
  protocol: string,
  ingestEndpointId: string,
  caps: RecipeBrowserCaps,
) {
  return playbackModesForSelection(protocol, ingestEndpointId).filter((item) =>
    playbackModeAllowedInBrowser(item.id, caps),
  );
}

export function resolvedSelectablePlaybackMode(
  mode: PlaybackMode | undefined,
  protocol: string,
  ingestEndpointId: string,
  caps: RecipeBrowserCaps,
): PlaybackMode {
  const resolved = resolvedPlaybackMode(mode, protocol, ingestEndpointId);
  if (
    isPlaybackModeCompatible(resolved, protocol, ingestEndpointId) &&
    playbackModeAllowedInBrowser(resolved, caps)
  ) {
    return resolved;
  }
  return selectablePlaybackModes(protocol, ingestEndpointId, caps)[0]?.id ?? resolved;
}

export function ingestAllowedForRecipe(
  ingestEndpointId: string,
  protocol: string,
  ctx: RecipeContext,
): boolean {
  if (!isPublishProtocol(protocol)) {
    return false;
  }
  if (selectablePlaybackModes(protocol, ingestEndpointId, ctx.caps).length === 0) {
    return false;
  }
  if (isCustomIngestEndpoint(ingestEndpointId)) {
    return ctx.source !== "browser_moq";
  }
  return ingestEndpointsForProtocol(protocol, ctx.presets).some(
    (item) => item.id === ingestEndpointId,
  );
}

export function destinationsForProtocol(
  protocol: string,
  ctx: RecipeContext,
  occupiedCollisionKeys: ReadonlySet<string>,
) {
  const preferredRole =
    protocol === "rtmp" ? "zixi" : protocol === "moq" ? "moq_relay" : "mediamtx";
  const hostRank = (id: string) => {
    const host = cloudHostFromIngest(id);
    if (host === "gcp") return 0;
    if (host === "gcp_east") return 1;
    if (host === "linode") return 2;
    return 3;
  };
  return ingestEndpointsForProtocol(protocol, ctx.presets)
    .filter((item) => {
      if (!ingestAllowedForRecipe(item.id, protocol, ctx)) {
        return false;
      }
      const key = ingestCollisionKey(item.id, protocol);
      return !(key && occupiedCollisionKeys.has(key));
    })
    .sort((a, b) => {
      const aCustom = isCustomIngestEndpoint(a.id) ? 1 : 0;
      const bCustom = isCustomIngestEndpoint(b.id) ? 1 : 0;
      if (aCustom !== bCustom) {
        return aCustom - bCustom;
      }
      const aRole = ingestRole(a.id) === preferredRole ? 0 : 1;
      const bRole = ingestRole(b.id) === preferredRole ? 0 : 1;
      if (aRole !== bRole) {
        return aRole - bRole;
      }
      return hostRank(a.id) - hostRank(b.id);
    });
}

function pickIngest(
  protocol: string,
  preferredIngest: string,
  ctx: RecipeContext,
  occupiedCollisionKeys: ReadonlySet<string>,
): IngestEndpointId {
  const dests = destinationsForProtocol(protocol, ctx, occupiedCollisionKeys);
  const preferredHost = cloudHostFromIngest(preferredIngest);
  const sameCloud = dests.find(
    (item) =>
      !isCustomIngestEndpoint(item.id) && cloudHostFromIngest(item.id) === preferredHost,
  );
  const managed = dests.find((item) => !isCustomIngestEndpoint(item.id));
  return (
    (sameCloud ?? managed ?? dests[0])?.id ??
    defaultIngestForProtocol(protocol, preferredHost)
  );
}

export function coerceEndpoint(
  endpoint: EndpointConfig,
  ctx: RecipeContext,
  occupiedCollisionKeys: ReadonlySet<string>,
): EndpointConfig {
  const allowed = publishProtocolIdsForSource(ctx.source, ctx.caps, recipePublisherCaps(ctx));
  let protocol = endpoint.protocol;
  if (!allowed.includes(protocol as PublishProtocolId)) {
    protocol = allowed[0] ?? "srt";
  }
  const currentKey = ingestCollisionKey(endpoint.ingestEndpointId, protocol);
  const currentOk =
    ingestAllowedForRecipe(endpoint.ingestEndpointId, protocol, ctx) &&
    !(currentKey && occupiedCollisionKeys.has(currentKey));
  const ingestEndpointId = currentOk
    ? endpoint.ingestEndpointId
    : pickIngest(protocol, endpoint.ingestEndpointId, ctx, occupiedCollisionKeys);
  const playbackMode = resolvedSelectablePlaybackMode(
    endpoint.playbackMode,
    protocol,
    ingestEndpointId,
    ctx.caps,
  );
  if (
    protocol === endpoint.protocol &&
    ingestEndpointId === endpoint.ingestEndpointId &&
    playbackMode === endpoint.playbackMode
  ) {
    return endpoint;
  }
  return { ...endpoint, protocol, ingestEndpointId, playbackMode };
}

export function coerceRecipe(endpoints: EndpointConfig[], ctx: RecipeContext): EndpointConfig[] {
  const sourceAdjusted =
    ctx.source === "browser_moq" ? collapseOutputsForBrowserMoq(endpoints) : endpoints;
  const used = new Set<string>();
  let changed = sourceAdjusted !== endpoints;
  const next = sourceAdjusted.map((endpoint) => {
    const coerced = coerceEndpoint(endpoint, ctx, used);
    if (coerced !== endpoint) {
      changed = true;
    }
    const key = ingestCollisionKey(coerced.ingestEndpointId, coerced.protocol);
    if (key) {
      used.add(key);
    }
    return coerced;
  });
  return changed ? next : endpoints;
}

export function siblingOccupiedCollisionKeys(
  endpoints: EndpointConfig[],
  endpointId: string,
): Set<string> {
  return new Set(
    endpoints
      .filter((endpoint) => endpoint.id !== endpointId)
      .map((endpoint) => ingestCollisionKey(endpoint.ingestEndpointId, endpoint.protocol))
      .filter((key): key is string => key !== null),
  );
}

function collisionKeysFor(endpoints: EndpointConfig[]): Set<string> {
  return new Set(
    endpoints
      .map((endpoint) => ingestCollisionKey(endpoint.ingestEndpointId, endpoint.protocol))
      .filter((key): key is string => key !== null),
  );
}

function tryAddProtocol(
  protocol: PublishProtocolId,
  current: EndpointConfig[],
  ctx: RecipeContext,
  used: ReadonlySet<string>,
): Omit<EndpointConfig, "id"> | null {
  if (!publishProtocolIdsForSource(ctx.source, ctx.caps, recipePublisherCaps(ctx)).includes(protocol)) {
    return null;
  }
  const usedLegs = new Set(
    current.map((endpoint) => `${endpoint.protocol}:${endpoint.ingestEndpointId}`),
  );
  const dests = destinationsForProtocol(protocol, ctx, used).filter((item) => {
    if (isCustomIngestEndpoint(item.id)) {
      return false;
    }
    if (ctx.source === "browser_moq" && usedLegs.has(`${protocol}:${item.id}`)) {
      return false;
    }
    return true;
  });
  const ingest = dests[0]?.id;
  if (!ingest) {
    return null;
  }
  return {
    protocol,
    ingestEndpointId: ingest,
    endpointUrl: "",
    vmafAvailable: false,
    serverMetricsAvailable: false,
    playbackMode: resolvedSelectablePlaybackMode(undefined, protocol, ingest, ctx.caps),
    playbackDvr: false,
  };
}

export function nextAddableEndpoint(
  current: EndpointConfig[],
  ctx: RecipeContext,
  protocolOrder?: readonly PublishProtocolId[],
): Omit<EndpointConfig, "id"> | null {
  const used = collisionKeysFor(current);
  if (ctx.source === "browser_moq") {
    if (!current.some((endpoint) => endpoint.protocol === "webrtc")) {
      const webrtc = tryAddProtocol("webrtc", current, ctx, used);
      if (webrtc) {
        return webrtc;
      }
    }
    return tryAddProtocol("moq", current, ctx, used) ?? tryAddProtocol("webrtc", current, ctx, used);
  }
  const order = protocolOrder ?? ["srt", "rtmp", "webrtc", "moq"];
  for (const protocol of order) {
    const created = tryAddProtocol(protocol, current, ctx, used);
    if (created) {
      return created;
    }
  }
  return null;
}

export function defaultRecipeEndpoints(ctx: RecipeContext): Omit<EndpointConfig, "id">[] {
  const pairs: PublishProtocolId[][] = [
    ["rtmp", "srt"],
    ["srt", "moq"],
    ["webrtc", "moq"],
    ["moq", "webrtc"],
  ];
  for (const pair of pairs) {
    const first = nextAddableEndpoint([], ctx, pair);
    if (!first) {
      continue;
    }
    if (ctx.source === "browser_moq") {
      return [first];
    }
    const second = nextAddableEndpoint([{ id: "seed-0", ...first }], ctx, [
      ...pair.slice(1),
      ...pair,
    ]);
    if (second) {
      return [first, second];
    }
  }
  const only = nextAddableEndpoint([], ctx);
  return only ? [only] : [];
}

export function canAddRecipeOutput(
  current: EndpointConfig[],
  ctx: RecipeContext,
  maxEndpoints: number,
): boolean {
  return current.length < maxEndpoints && nextAddableEndpoint(current, ctx) !== null;
}

export function recipeIssue(endpoints: EndpointConfig[], ctx: RecipeContext): string | null {
  const allowed = publishProtocolIdsForSource(ctx.source, ctx.caps, recipePublisherCaps(ctx));
  const used = new Set<string>();
  for (const endpoint of endpoints) {
    if (!allowed.includes(endpoint.protocol as PublishProtocolId)) {
      if (
        endpoint.protocol === "webrtc" &&
        ctx.source === "webcam" &&
        !recipePublisherCaps(ctx).localFfmpegWhip
      ) {
        return "WebRTC is unavailable on this machine — its ffmpeg has no WHIP muxer. Use SRT, RTMP, or MoQ, or upgrade ffmpeg.";
      }
      return "This output uses a protocol that is not available here.";
    }
    if (!ingestAllowedForRecipe(endpoint.ingestEndpointId, endpoint.protocol, ctx)) {
      return "This output’s destination is not supported for that protocol.";
    }
    const key = ingestCollisionKey(endpoint.ingestEndpointId, endpoint.protocol);
    if (key) {
      if (used.has(key)) {
        return "Two outputs share the same ingest path.";
      }
      used.add(key);
    }
    const mode = resolvedSelectablePlaybackMode(
      endpoint.playbackMode,
      endpoint.protocol,
      endpoint.ingestEndpointId,
      ctx.caps,
    );
    if (
      !isPlaybackModeCompatible(mode, endpoint.protocol, endpoint.ingestEndpointId) ||
      !playbackModeAllowedInBrowser(mode, ctx.caps)
    ) {
      return "This output’s player is not supported for that destination.";
    }
    if (endpoint.playbackMode && endpoint.playbackMode !== mode) {
      return "This output’s player is not supported for that destination.";
    }
    if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
      if (!endpoint.endpointUrl.trim()) {
        return "Enter a publish URL for Custom URL.";
      }
      if (mode === "whep" && !endpoint.whepPlaybackUrl?.trim()) {
        return "Enter a WHEP URL for custom WebRTC playback.";
      }
    }
  }
  return null;
}
