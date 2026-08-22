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
export type RecipeEncoderId = "ffmpeg" | "obs" | "browser";

/** Webcam encodes on this laptop via the publisher agent (ffmpeg / OBS). */
export function isLocalAgentSource(source: RecipeSourceId): boolean {
  return source === "webcam";
}

/**
 * Last-mile encoder for this source. Cloud playout stays server ffmpeg.
 * In-tab Browser is an encoder (Webcam + Browser, or legacy source=browser_moq).
 */
export function recipeEncoderForSource(
  source: RecipeSourceId,
  encoder: RecipeEncoderId = "ffmpeg",
): RecipeEncoderId {
  if (source === "browser_moq") {
    return "browser";
  }
  return source === "webcam" ? encoder : "ffmpeg";
}

/** Webcam + Browser engine (or legacy Browser source) publishes MoQ / WebRTC. */
export function isBrowserPublish(
  source: RecipeSourceId,
  encoder: RecipeEncoderId = "ffmpeg",
): boolean {
  return recipeEncoderForSource(source, encoder) === "browser";
}

/** OpenMOQ plugin occupies OBS Settings → Stream, so the recipe must include MoQ. */
export function recipeRequiresMoq(ctx: Pick<RecipeContext, "source" | "encoder">): boolean {
  return recipeEncoderForSource(ctx.source, ctx.encoder ?? "ffmpeg") === "obs";
}

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
  /** ffmpeg (default) or OBS as the last-mile encoder. */
  encoder?: RecipeEncoderId;
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
  encoder: RecipeEncoderId = "ffmpeg",
): PublishProtocolId[] {
  const effective = recipeEncoderForSource(source, encoder);
  const live: PublishProtocolId[] = isBrowserPublish(source, encoder)
    ? ["moq", "webrtc"]
    : ["srt", "rtmp", "webrtc", "moq"];
  return live.filter((protocol) => {
    if (!protocolAllowedInBrowser(protocol, caps)) {
      return false;
    }
    // Laptop ffmpeg encode is the local agent. No WHIP muxer → no WebRTC option.
    if (protocol === "webrtc" && isLocalAgentSource(source) && effective === "ffmpeg" && !publisher.localFfmpegWhip) {
      return false;
    }
    // OBS + OpenMOQ plugin: MoQ via the plugin, SRT/RTMP via OBS outputs. No WHIP.
    if (protocol === "webrtc" && effective === "obs") {
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
    return !isBrowserPublish(ctx.source, ctx.encoder ?? "ffmpeg");
  }
  // openmoq-plugin is draft-16 / :4433 only. Public MoQ is :14433.
  if (
    recipeEncoderForSource(ctx.source, ctx.encoder ?? "ffmpeg") === "obs" &&
    protocol === "moq" &&
    ingestEndpointId.includes("moq_relay_d18")
  ) {
    return false;
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
      // Draft-18 :14433 before leftover :4433 so Add output cannot pick draft-16.
      if (protocol === "moq") {
        const aD18 = a.id.endsWith("_d18") ? 0 : 1;
        const bD18 = b.id.endsWith("_d18") ? 0 : 1;
        if (aD18 !== bD18) {
          return aD18 - bD18;
        }
      }
      return hostRank(a.id) - hostRank(b.id);
    });
}

/** True when OBS can publish MoQ (draft-16 dest exists). Public site is d18-only. */
export function obsMoqSupported(ctx: RecipeContext): boolean {
  return destinationsForProtocol("moq", { ...ctx, encoder: "obs" }, new Set()).length > 0;
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

/**
 * Merge a UI patch into an output. A protocol switch invalidates the previous
 * player unless the same patch names one: isPlaybackModeCompatible whitelists
 * the MediaMTX LL-HLS remux for webrtc, so a leg switched from SRT to WebRTC
 * would keep its inherited "ll-hls" and never open a WHEP session.
 */
export function applyEndpointPatch(
  endpoint: EndpointConfig,
  patch: Partial<EndpointConfig>,
): EndpointConfig {
  const next = { ...endpoint, ...patch };
  if (patch.protocol !== undefined && patch.protocol !== endpoint.protocol && !patch.playbackMode) {
    next.playbackMode = undefined;
  }
  return next;
}

export function coerceEndpoint(
  endpoint: EndpointConfig,
  ctx: RecipeContext,
  occupiedCollisionKeys: ReadonlySet<string>,
): EndpointConfig {
  const allowed = publishProtocolIdsForSource(
    ctx.source,
    ctx.caps,
    recipePublisherCaps(ctx),
    ctx.encoder ?? "ffmpeg",
  );
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
  // Re-default the player when this call is what changed the protocol; a mode
  // inherited from the old protocol can still read as "compatible".
  const playbackMode = resolvedSelectablePlaybackMode(
    protocol === endpoint.protocol ? endpoint.playbackMode : undefined,
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
  const sourceAdjusted = isBrowserPublish(ctx.source, ctx.encoder ?? "ffmpeg")
    ? collapseOutputsForBrowserMoq(endpoints)
    : endpoints;
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
  if (
    !publishProtocolIdsForSource(
      ctx.source,
      ctx.caps,
      recipePublisherCaps(ctx),
      ctx.encoder ?? "ffmpeg",
    ).includes(protocol)
  ) {
    return null;
  }
  const usedLegs = new Set(
    current.map((endpoint) => `${endpoint.protocol}:${endpoint.ingestEndpointId}`),
  );
  const dests = destinationsForProtocol(protocol, ctx, used).filter((item) => {
    if (isCustomIngestEndpoint(item.id)) {
      return false;
    }
    if (
      isBrowserPublish(ctx.source, ctx.encoder ?? "ffmpeg") &&
      usedLegs.has(`${protocol}:${item.id}`)
    ) {
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
  if (isBrowserPublish(ctx.source, ctx.encoder ?? "ffmpeg")) {
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
  const pairs: PublishProtocolId[][] = recipeRequiresMoq(ctx)
    ? [
        ["srt", "moq"],
        ["rtmp", "moq"],
        ["moq", "srt"],
      ]
    : [
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
    if (isBrowserPublish(ctx.source, ctx.encoder ?? "ffmpeg")) {
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
  const allowed = publishProtocolIdsForSource(
    ctx.source,
    ctx.caps,
    recipePublisherCaps(ctx),
    ctx.encoder ?? "ffmpeg",
  );
  if (recipeRequiresMoq(ctx)) {
    const moqDests = destinationsForProtocol("moq", ctx, new Set());
    if (moqDests.length === 0) {
      return "OBS OpenMOQ plugin is draft-16 only. Public MoQ is draft-18 (:14433). Use ffmpeg (helper) for MoQ.";
    }
    if (!endpoints.some((endpoint) => endpoint.protocol === "moq")) {
      return "OBS needs a MoQ output — the plugin occupies Settings → Stream. Add SRT/RTMP alongside it.";
    }
  }
  const used = new Set<string>();
  for (const endpoint of endpoints) {
    if (!allowed.includes(endpoint.protocol as PublishProtocolId)) {
      if (endpoint.protocol === "webrtc" && recipeRequiresMoq(ctx)) {
        return "OBS encode supports SRT, RTMP, and MoQ — not WebRTC. Use ffmpeg (helper) for WebRTC.";
      }
      if (
        endpoint.protocol === "webrtc" &&
        isLocalAgentSource(ctx.source) &&
        !recipePublisherCaps(ctx).localFfmpegWhip
      ) {
        return "This laptop cannot publish WebRTC yet. Use SRT, RTMP, or MoQ, or switch to Cloud playout or Webcam + Browser.";
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
