/**
 * Quick-start recipes for first-time visitors. Each preset is a known-good
 * source + encoder + output set that already exists in ingestEndpoints /
 * operator recipes. Applying a preset only fills the form — Start is unchanged.
 *
 * Precanned recipes pick ingest hosts, players, and gateways for the
 * operator. The dest/player matrix stays on Build Your Own only.
 * `lockProtocolMix` hides per-tile protocol dropdowns (Cloud: one shared
 * picker; Contribution: fixed 3-way mix). Locking `outputs` hides
 * Add/remove and Destination pickers. Run parameters (Live Edge vs
 * Complete, bitrate, VMAF) stay visible.
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
   * whenever `outputs` is locked.
   */
  lockEndpoints?: boolean;
  /** One-line “what you will see” after picking this recipe. */
  lockedSummary: string;
}

/** No visitor default — the first screen is only “What to Run”. */
export const DEFAULT_BENCHMARK_PRESET: BenchmarkPresetId | null = null;

/** Greyed placeholder in the preset group — not a runnable recipe yet. */
export const PLAYER_TEST_PLACEHOLDER = {
  id: "player-test",
  label: "Player Test",
  hint: "Coming soon.",
} as const;

/** Heading for the four precanned recipes (Build Your Own sits outside this group). */
export const PRESET_COMPARISON_GROUP_LABEL = "Preset Comparisons";

/**
 * Visitor card order: most stable preset → least stable, then Build Your Own
 * last (least constrained). Do not shuffle without updating the group chrome.
 */
export const BENCHMARK_PRESET_DEFS: BenchmarkPresetDef[] = [
  {
    id: "protocol-compare",
    label: "Protocol Comparison",
    hint: "Compare SRT, RTMP, WebRTC, and MoQ on the most stable path for each.",
    locks: ["testScope", "outputs"],
    lockedSummary: "SRT, RTMP, WebRTC, and MoQ on the most stable path for each.",
  },
  {
    id: "cloud-compare",
    label: "Cloud/Edge Comparison",
    hint: "Compare the same protocol across live clouds and regions. Paths and players are chosen for you.",
    locks: ["testScope", "outputs"],
    lockProtocolMix: true,
    lockedSummary: "One protocol, compared across live clouds and regions.",
  },
  {
    id: "contribution-compare",
    label: "Ingest Comparison",
    hint: "Contribution and acquisition performance across clouds and protocols.",
    locks: ["testScope", "encoder", "outputs"],
    lockProtocolMix: true,
    lockedSummary: "Encode and ingest meters only. No players.",
  },
  {
    id: "webrtc-vs-moq",
    label: "Webcam Browsers",
    hint: "Webcam and WebCodecs protocol comparison.",
    locks: ["testScope", "source", "encoder", "outputs"],
    lockedSummary: "Webcam via WebCodecs: MoQ vs WebRTC.",
  },
  {
    id: "build-your-own",
    label: "Build Your Own",
    hint: "You pick the source, destinations, and players.",
    locks: [],
    lockedSummary: "",
  },
];

export const PRESET_COMPARISON_DEFS: BenchmarkPresetDef[] = BENCHMARK_PRESET_DEFS.filter(
  (item) => item.id !== "build-your-own",
);

export const BUILD_YOUR_OWN_DEF = BENCHMARK_PRESET_DEFS.find((item) => item.id === "build-your-own");

export function recipeDef(id: BenchmarkPresetId | null): BenchmarkPresetDef | undefined {
  return id ? BENCHMARK_PRESET_DEFS.find((item) => item.id === id) : undefined;
}

export function recipeLocksStep(id: BenchmarkPresetId | null, step: RecipeWizardStep): boolean {
  return recipeDef(id)?.locks.includes(step) ?? false;
}

/** Later wizard steps stay hidden until a recipe is picked. Build Your Own shows all. */
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
 * Destination / ingest-host pickers. Build Your Own shows them. Precanned
 * recipes lock `outputs` so the matrix stays hidden — hosts and players
 * are chosen from the most stable path for that recipe.
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
  return recipeLocksStep(id, "outputs");
}

export function recipeShowsEndpointPickers(id: BenchmarkPresetId | null): boolean {
  if (id === null) {
    return false;
  }
  return !recipeLocksEndpoints(id);
}

/**
 * One protocol picker for every tile. Cloud compare keeps this even when
 * the dest/player matrix is hidden. Contribution has a fixed 3-way mix.
 */
export function recipeShowsSharedProtocolPicker(id: BenchmarkPresetId | null): boolean {
  return id === "cloud-compare" && recipeLocksProtocolMix(id);
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
  if (protocol === "webrtc") {
    return "Same publish on every live region that accepts it.";
  }
  if (protocol === "moq") {
    return "Same publish on every live public relay.";
  }
  return "Same publish on every live region.";
}

/** Contribution compare needs the laptop helper (SRT/RTMP + webcam ffmpeg). */
export function recipeNeedsLaptopHelper(id: BenchmarkPresetId): boolean {
  return id === "contribution-compare";
}

/**
 * Precanned recipes never open the dest/player matrix before Start.
 * Build Your Own walks that step. Run tiles still appear once a job starts.
 */
export function recipeRevealsLockedOutputs(_id: BenchmarkPresetId | null): boolean {
  return false;
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
  return "bbb";
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
 * Protocol-compare 4-way: SRT on MediaMTX LL-HLS (never Central Zixi HTTP-TS),
 * RTMP on Zixi so it does not collide with SRT/WHIP on the same MTX path,
 * WHIP on the next free MediaMTX, MoQ on :14433. Prefer the user's last
 * cloud; never AWS.
 */
function preferredFourWayRole(protocol: PublishProtocolId): "zixi" | "mediamtx" | "moq_relay" {
  if (protocol === "rtmp") {
    return "zixi";
  }
  if (protocol === "moq") {
    return "moq_relay";
  }
  return "mediamtx";
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
    const source: RecipeSourceId = options.source ?? ctx.source ?? "bbb";
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
