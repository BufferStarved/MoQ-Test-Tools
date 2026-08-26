/**
 * Quick-start recipes for first-time visitors. Each preset is a known-good
 * source + encoder + output set that already exists in ingestEndpoints /
 * operator recipes. Applying a preset only fills the form — Start is unchanged.
 *
 * Precanned recipes default tiles/players and mask later wizard steps that
 * they already decided. `lockProtocolMix` hides per-tile protocol dropdowns
 * (Cloud: one shared picker; Contribution: fixed 3-way mix).
 * `lockEndpoints` hides Destination pickers. Locking `outputs` still hides
 * Add/remove unless the recipe unlocks that step. Run parameters (live-edge
 * vs complete, bitrate, VMAF) stay visible. "Build your own" locks nothing.
 */
import {
  CLOUD_ENCODE_HOST_IDS,
  cloudHostFromIngest,
  ingestCollisionKey,
  ingestRole,
  isCustomIngestEndpoint,
  type CloudEncodeHostId,
} from "./ingestEndpoints.ts";
import { operatorEndpoints, BROWSER4_OUTPUT_KEYS, OPERATOR_OUTPUTS } from "./operatorRecipe.ts";
import {
  coerceRecipe,
  defaultRecipeEndpoints,
  destinationsForProtocol,
  isCloudPlayoutSource,
  nextAddableEndpoint,
  publishProtocolIdsForSource,
  recipeIssue,
  resolvedSelectablePlaybackMode,
  type RecipeContext,
  type RecipeEncoderId,
  type RecipeSourceId,
  type PublishProtocolId,
} from "./recipeSupport.ts";
import type { EndpointConfig } from "./types.ts";
import { TEST_SCOPE_E2E, TEST_SCOPE_UPLOAD, type TestScope } from "./testScope.ts";

export type BenchmarkPresetId =
  | "protocol-compare"
  | "build-your-own"
  | "cloud-compare"
  | "contribution-compare"
  | "webrtc-vs-moq";

/** Wizard steps a recipe may lock (hide) after apply. Encode bitrate / policy / VMAF stay open. */
export type RecipeWizardStep = "testScope" | "source" | "encoder" | "outputs";

export interface BenchmarkPresetDef {
  id: BenchmarkPresetId;
  label: string;
  hint: string;
  locks: readonly RecipeWizardStep[];
  /**
   * Hide per-tile protocol dropdowns. Cloud compare shows one shared
   * picker so every tile uses the same protocol. Contribution keeps a
   * fixed SRT + RTMP + MoQ mix (no picker).
   */
  lockProtocolMix?: boolean;
  /**
   * Hide Destination / ingest-host pickers. Defaults to locking them
   * whenever `outputs` is locked, unless `showEndpointPickers` is set.
   */
  lockEndpoints?: boolean;
  /**
   * Show per-tile Destination pickers even when `outputs` is locked.
   * Without this, locking outputs hides protocol mix AND ingest hosts.
   */
  showEndpointPickers?: boolean;
  /** One-line reminder of what the recipe hid. Empty for Build your own. */
  lockedSummary: string;
}

export const BENCHMARK_PRESET_DEFS: BenchmarkPresetDef[] = [
  {
    id: "protocol-compare",
    label: "Capture to glass",
    hint: "SRT + RTMP + WebRTC + MoQ :14433 · players side by side",
    locks: ["testScope", "outputs"],
    lockedSummary: "This recipe locked: 4 outputs (SRT/RTMP/WHIP/MoQ :14433)",
  },
  {
    id: "webrtc-vs-moq",
    label: "MoQ vs WebRTC",
    hint: "Webcam + Browser · realtime join on Linode/East",
    locks: ["testScope", "source", "encoder", "outputs"],
    lockedSummary: "This recipe locked: Browser encode · 4 outputs (MoQ + WHEP)",
  },
  {
    id: "cloud-compare",
    label: "Where to host",
    hint: "Same protocol across GCP / Linode / AWS · grey cells are not deployed",
    locks: ["testScope"],
    lockProtocolMix: true,
    lockEndpoints: false,
    lockedSummary: "This recipe locked: one protocol × N cloud endpoints.",
  },
  {
    id: "contribution-compare",
    label: "Ingest only",
    hint: "SRT + RTMP + MoQ :14433 · confidence monitor, no players",
    locks: ["testScope", "encoder", "outputs"],
    lockProtocolMix: true,
    lockEndpoints: false,
    showEndpointPickers: true,
    lockedSummary: "This recipe locked: upload-only · helper · protocol mix (SRT/RTMP/MoQ :14433)",
  },
  {
    id: "build-your-own",
    label: "Custom",
    hint: "Pick source, outputs, destinations, and players.",
    locks: [],
    lockedSummary: "",
  },
];

export function recipeDef(id: BenchmarkPresetId | null): BenchmarkPresetDef | undefined {
  return id ? BENCHMARK_PRESET_DEFS.find((item) => item.id === id) : undefined;
}

export function recipeLocksStep(id: BenchmarkPresetId | null, step: RecipeWizardStep): boolean {
  return recipeDef(id)?.locks.includes(step) ?? false;
}

/** Later wizard steps stay hidden until a recipe is picked. Build your own shows all. */
export function wizardStepVisible(
  id: BenchmarkPresetId | null,
  step: RecipeWizardStep,
): boolean {
  if (id === null) {
    return false;
  }
  return !recipeLocksStep(id, step);
}

export function recipeLocksProtocolMix(id: BenchmarkPresetId | null): boolean {
  return recipeDef(id)?.lockProtocolMix === true;
}

/**
 * Destination / ingest-host pickers. Unlocked recipes show them; locking
 * `outputs` hides them unless `lockEndpoints` is false or `showEndpointPickers`
 * is set. Cloud compare unlocks endpoints so each tile is a region.
 */
export function recipeLocksEndpoints(id: BenchmarkPresetId | null): boolean {
  if (id === null) {
    return true;
  }
  const def = recipeDef(id);
  if (!def) {
    return true;
  }
  if (def.lockEndpoints === true) {
    return true;
  }
  if (def.lockEndpoints === false) {
    return false;
  }
  if (def.showEndpointPickers) {
    return false;
  }
  return recipeLocksStep(id, "outputs");
}

export function recipeShowsEndpointPickers(id: BenchmarkPresetId | null): boolean {
  if (id === null) {
    return false;
  }
  return !recipeLocksEndpoints(id);
}

/**
 * One protocol picker for every tile. True when the mix is locked to a
 * single protocol and output tiles stay visible (Cloud compare).
 * Contribution locks `outputs` so the 3-way mix has no picker.
 */
export function recipeShowsSharedProtocolPicker(id: BenchmarkPresetId | null): boolean {
  return recipeLocksProtocolMix(id) && wizardStepVisible(id, "outputs");
}

export function cloudCompareProtocolLabel(protocol: PublishProtocolId): string {
  if (protocol === "webrtc") {
    return "WebRTC / WHIP";
  }
  if (protocol === "moq") {
    return "MoQ draft-18 :14433";
  }
  return protocol.toUpperCase();
}

export function cloudCompareProtocolHint(protocol: PublishProtocolId): string {
  if (protocol === "srt" || protocol === "rtmp") {
    return "Zixi or MediaMTX in each wired region";
  }
  if (protocol === "webrtc") {
    return "MediaMTX WHIP URLs that exist — not AWS";
  }
  return "Public :14433 relays — leftover :4433 hidden";
}

/** Contribution compare needs the laptop helper (SRT/RTMP + webcam ffmpeg). */
export function recipeNeedsLaptopHelper(id: BenchmarkPresetId): boolean {
  return id === "contribution-compare";
}

export function recipeLockedSummary(id: BenchmarkPresetId | null): string | null {
  const summary = recipeDef(id)?.lockedSummary?.trim();
  return summary ? summary : null;
}

export interface AppliedBenchmarkPreset {
  source: RecipeSourceId;
  encoder: RecipeEncoderId;
  endpoints: EndpointConfig[];
  testScope: TestScope;
}

export interface ApplyBenchmarkPresetOptions {
  /** Reuse last-picked ingest clouds. Never invent AWS. */
  currentEndpoints?: EndpointConfig[];
  currentTestScope?: TestScope;
  /** Protocol comparison defaults dummy; contribution defaults webcam. Pass to keep a user-picked source. */
  source?: RecipeSourceId;
  encoder?: RecipeEncoderId;
  /** Cloud compare: one protocol on every tile. */
  protocol?: PublishProtocolId;
}

function withIds(
  seeds: Omit<EndpointConfig, "id">[],
  nextId: () => string,
): EndpointConfig[] {
  return seeds.map((endpoint) => ({ ...endpoint, id: nextId() }));
}

const CLOUD_COMPARE_HOSTS: CloudEncodeHostId[] = [...CLOUD_ENCODE_HOST_IDS];

function cloudCompareRole(protocol: PublishProtocolId): "zixi" | "mediamtx" | "moq_relay" {
  if (protocol === "moq") {
    return "moq_relay";
  }
  if (protocol === "rtmp") {
    return "zixi";
  }
  return "mediamtx";
}

function cloudCompareSource(requested?: RecipeSourceId): RecipeSourceId {
  if (
    requested === "webcam" ||
    requested === "browser_moq" ||
    (requested && isCloudPlayoutSource(requested))
  ) {
    return requested;
  }
  return "dummy";
}

function cloudCompareEncoder(source: RecipeSourceId, requested?: RecipeEncoderId): RecipeEncoderId {
  if (source === "browser_moq") {
    return "browser";
  }
  if (source === "webcam" && requested === "browser") {
    return "browser";
  }
  return "ffmpeg";
}

function cloudCompareProtocol(
  ctx: RecipeContext,
  requested?: PublishProtocolId,
  current?: EndpointConfig[],
): PublishProtocolId {
  const allowed = publishProtocolIdsForSource(
    ctx.source,
    ctx.caps,
    ctx.publisher,
    ctx.encoder ?? "ffmpeg",
  );
  if (requested && allowed.includes(requested)) {
    return requested;
  }
  const currentProtocol = current?.[0]?.protocol as PublishProtocolId | undefined;
  if (
    currentProtocol &&
    allowed.includes(currentProtocol) &&
    current?.every((endpoint) => endpoint.protocol === currentProtocol)
  ) {
    return currentProtocol;
  }
  if (allowed.includes("srt")) {
    return "srt";
  }
  return allowed[0] ?? "srt";
}

function cloudCompareEndpoints(
  protocol: PublishProtocolId,
  ctx: RecipeContext,
  nextId: () => string,
  current?: EndpointConfig[],
): EndpointConfig[] {
  let endpoints: EndpointConfig[] = [];
  const preferredHosts: CloudEncodeHostId[] = [];
  for (const endpoint of current ?? []) {
    if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
      continue;
    }
    const host = cloudHostFromIngest(endpoint.ingestEndpointId);
    if (!preferredHosts.includes(host)) {
      preferredHosts.push(host);
    }
  }
  const hosts = [...preferredHosts, ...CLOUD_COMPARE_HOSTS.filter((host) => !preferredHosts.includes(host))];
  for (const host of hosts) {
    if (endpoints.length >= CLOUD_COMPARE_HOSTS.length) {
      break;
    }
    const seed = seedProtocolOnHost(protocol, endpoints, ctx, host, cloudCompareRole(protocol));
    if (seed && cloudHostFromIngest(seed.ingestEndpointId) === host) {
      endpoints = [...endpoints, { id: nextId(), ...seed }];
    }
  }
  if (endpoints.length === 0) {
    const first = nextAddableEndpoint([], ctx, [protocol]);
    if (first) {
      endpoints = [{ id: nextId(), ...first }];
    }
  }
  if (endpoints.length === 0) {
    return withIds(defaultRecipeEndpoints(ctx), nextId);
  }
  return coerceRecipe(endpoints, ctx);
}

/** Webcam (laptop→cloud) or existing cloud playout / VOD — never Browser. */
function contributionSource(requested?: RecipeSourceId): RecipeSourceId {
  if (requested === "webcam" || (requested && isCloudPlayoutSource(requested))) {
    return requested;
  }
  return "webcam";
}

function contributionRole(protocol: PublishProtocolId): "zixi" | "mediamtx" | "moq_relay" {
  if (protocol === "moq") {
    return "moq_relay";
  }
  if (protocol === "rtmp") {
    return "zixi";
  }
  return "mediamtx";
}

function contributionEndpoints(
  ctx: RecipeContext,
  nextId: () => string,
  current?: EndpointConfig[],
): EndpointConfig[] {
  const host = preferredHostFromCurrent(current);
  const order: PublishProtocolId[] = ["srt", "rtmp", "moq"];
  let endpoints: EndpointConfig[] = [];
  for (const protocol of order) {
    const seed = seedProtocolOnHost(protocol, endpoints, ctx, host, contributionRole(protocol));
    if (seed) {
      endpoints = [...endpoints, { id: nextId(), ...seed }];
    }
  }
  if (endpoints.length < 2) {
    return withIds(defaultRecipeEndpoints(ctx), nextId);
  }
  return endpoints;
}

function collisionUsed(endpoints: EndpointConfig[]): Set<string> {
  return new Set(
    endpoints
      .map((endpoint) => ingestCollisionKey(endpoint.ingestEndpointId, endpoint.protocol))
      .filter((key): key is string => key !== null),
  );
}

/** Last cloud the user already has on a tile. GCP Central if none. */
function preferredHostFromCurrent(current?: EndpointConfig[]): CloudEncodeHostId {
  for (const endpoint of current ?? []) {
    if (isCustomIngestEndpoint(endpoint.ingestEndpointId)) {
      continue;
    }
    return cloudHostFromIngest(endpoint.ingestEndpointId);
  }
  return "gcp_central";
}

/**
 * Same-cloud 4-way: SRT+RTMP on Zixi (no MediaMTX collision), WHIP on
 * MediaMTX, MoQ on :14433. Prefer the user's last cloud; never AWS.
 */
function preferredFourWayRole(protocol: PublishProtocolId): "zixi" | "mediamtx" | "moq_relay" {
  if (protocol === "webrtc") {
    return "mediamtx";
  }
  if (protocol === "moq") {
    return "moq_relay";
  }
  return "zixi";
}

function seedProtocolOnHost(
  protocol: PublishProtocolId,
  current: EndpointConfig[],
  ctx: RecipeContext,
  preferredHost: CloudEncodeHostId,
  role: "zixi" | "mediamtx" | "moq_relay",
): Omit<EndpointConfig, "id"> | null {
  const used = collisionUsed(current);
  const dests = destinationsForProtocol(protocol, ctx, used).filter((item) => {
    if (isCustomIngestEndpoint(item.id)) {
      return false;
    }
    if (!item.available) {
      return false;
    }
    if (protocol === "moq" && !item.id.endsWith("_d18")) {
      return false;
    }
    return true;
  });
  if (dests.length === 0) {
    return null;
  }
  const ranked = [...dests].sort((left, right) => {
    const leftHost = cloudHostFromIngest(left.id) === preferredHost ? 0 : 1;
    const rightHost = cloudHostFromIngest(right.id) === preferredHost ? 0 : 1;
    if (leftHost !== rightHost) {
      return leftHost - rightHost;
    }
    const leftRole = ingestRole(left.id) === role ? 0 : 1;
    const rightRole = ingestRole(right.id) === role ? 0 : 1;
    return leftRole - rightRole;
  });
  const pick = ranked[0];
  if (!pick) {
    return null;
  }
  return {
    protocol,
    ingestEndpointId: pick.id,
    endpointUrl: "",
    vmafAvailable: false,
    serverMetricsAvailable: false,
    playbackMode: resolvedSelectablePlaybackMode(undefined, protocol, pick.id, ctx.caps),
    playbackDvr: false,
  };
}

function protocolCompareEndpoints(
  ctx: RecipeContext,
  nextId: () => string,
  current?: EndpointConfig[],
): EndpointConfig[] {
  const host = preferredHostFromCurrent(current);
  const order: PublishProtocolId[] = ["srt", "rtmp", "webrtc", "moq"];
  let endpoints: EndpointConfig[] = [];
  for (const protocol of order) {
    const seed = seedProtocolOnHost(protocol, endpoints, ctx, host, preferredFourWayRole(protocol));
    if (seed) {
      endpoints = [...endpoints, { id: nextId(), ...seed }];
    }
  }
  if (endpoints.length === 0) {
    return withIds(defaultRecipeEndpoints(ctx), nextId);
  }
  return coerceRecipe(endpoints, ctx);
}

export function applyBenchmarkPreset(
  id: BenchmarkPresetId,
  ctx: RecipeContext,
  nextId: () => string,
  options: ApplyBenchmarkPresetOptions = {},
): AppliedBenchmarkPreset {
  if (id === "build-your-own") {
    const source = ctx.source;
    const encoder = ctx.encoder ?? "ffmpeg";
    const nextCtx = { ...ctx, source, encoder };
    const endpoints =
      options.currentEndpoints && options.currentEndpoints.length > 0
        ? coerceRecipe(options.currentEndpoints, nextCtx)
        : withIds(defaultRecipeEndpoints(nextCtx), nextId);
    return {
      source,
      encoder,
      testScope: options.currentTestScope ?? TEST_SCOPE_E2E,
      endpoints,
    };
  }
  if (id === "protocol-compare") {
    const source: RecipeSourceId = options.source ?? "dummy";
    const encoder: RecipeEncoderId =
      options.encoder ?? (source === "browser_moq" ? "browser" : "ffmpeg");
    const nextCtx = { ...ctx, source, encoder };
    return {
      source,
      encoder,
      testScope: TEST_SCOPE_E2E,
      endpoints: protocolCompareEndpoints(nextCtx, nextId, options.currentEndpoints),
    };
  }
  if (id === "cloud-compare") {
    const source: RecipeSourceId = cloudCompareSource(options.source ?? ctx.source);
    const encoder: RecipeEncoderId = cloudCompareEncoder(source, options.encoder ?? ctx.encoder);
    const nextCtx = { ...ctx, source, encoder };
    const protocol = cloudCompareProtocol(nextCtx, options.protocol, options.currentEndpoints);
    return {
      source,
      encoder,
      testScope: TEST_SCOPE_E2E,
      endpoints: cloudCompareEndpoints(protocol, nextCtx, nextId, options.currentEndpoints),
    };
  }
  if (id === "contribution-compare") {
    const source: RecipeSourceId = contributionSource(options.source);
    const encoder: RecipeEncoderId = "ffmpeg";
    const nextCtx = { ...ctx, source, encoder };
    return {
      source,
      encoder,
      testScope: TEST_SCOPE_UPLOAD,
      endpoints: coerceRecipe(
        contributionEndpoints(nextCtx, nextId, options.currentEndpoints),
        nextCtx,
      ),
    };
  }
  const source: RecipeSourceId = "browser_moq";
  const encoder: RecipeEncoderId = "browser";
  const nextCtx = { ...ctx, source, encoder };
  const specs = BROWSER4_OUTPUT_KEYS.map((key) => OPERATOR_OUTPUTS[key]);
  return {
    source,
    encoder,
    testScope: TEST_SCOPE_E2E,
    endpoints: coerceRecipe(operatorEndpoints(specs, nextId), nextCtx),
  };
}

export function benchmarkPresetLegal(
  applied: AppliedBenchmarkPreset,
  ctx: RecipeContext,
): boolean {
  const nextCtx = { ...ctx, source: applied.source, encoder: applied.encoder };
  return applied.endpoints.length > 0 && recipeIssue(applied.endpoints, nextCtx) === null;
}
