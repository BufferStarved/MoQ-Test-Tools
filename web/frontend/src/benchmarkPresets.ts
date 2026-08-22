/**
 * Quick-start recipes for first-time visitors. Each preset is a known-good
 * source + encoder + output set that already exists in ingestEndpoints /
 * operator recipes. Applying a preset only fills the form — Start is unchanged.
 */
import { operatorEndpoints, BROWSER4_OUTPUT_KEYS, OPERATOR_OUTPUTS } from "./operatorRecipe";
import {
  coerceRecipe,
  defaultRecipeEndpoints,
  nextAddableEndpoint,
  recipeIssue,
  type RecipeContext,
  type RecipeEncoderId,
  type RecipeSourceId,
} from "./recipeSupport";
import type { EndpointConfig } from "./types";

export type BenchmarkPresetId = "cloud-compare" | "contribution-compare" | "webrtc-vs-moq";

export interface BenchmarkPresetDef {
  id: BenchmarkPresetId;
  label: string;
  hint: string;
}

export const BENCHMARK_PRESET_DEFS: BenchmarkPresetDef[] = [
  {
    id: "cloud-compare",
    label: "Cloud compare",
    hint: "Dummy bars · server ffmpeg · hosted SRT vs MoQ",
  },
  {
    id: "contribution-compare",
    label: "Contribution compare",
    hint: "Webcam · ffmpeg helper · SRT + RTMP + MoQ",
  },
  {
    id: "webrtc-vs-moq",
    label: "WebRTC vs MoQ",
    hint: "Webcam · Browser encode · Linode/East MoQ + WebRTC",
  },
];

export interface AppliedBenchmarkPreset {
  source: RecipeSourceId;
  encoder: RecipeEncoderId;
  endpoints: EndpointConfig[];
}

function withIds(
  seeds: Omit<EndpointConfig, "id">[],
  nextId: () => string,
): EndpointConfig[] {
  return seeds.map((endpoint) => ({ ...endpoint, id: nextId() }));
}

function contributionEndpoints(ctx: RecipeContext, nextId: () => string): EndpointConfig[] {
  const first = nextAddableEndpoint([], ctx, ["srt", "rtmp", "moq"]);
  if (!first) {
    return withIds(defaultRecipeEndpoints(ctx), nextId);
  }
  let endpoints: EndpointConfig[] = [{ id: nextId(), ...first }];
  const second = nextAddableEndpoint(endpoints, ctx, ["rtmp", "moq", "srt"]);
  if (second) {
    endpoints = [...endpoints, { id: nextId(), ...second }];
    const third = nextAddableEndpoint(endpoints, ctx, ["moq", "srt", "rtmp"]);
    if (third) {
      endpoints = [...endpoints, { id: nextId(), ...third }];
    }
  }
  if (endpoints.length < 2) {
    return withIds(defaultRecipeEndpoints(ctx), nextId);
  }
  return endpoints;
}

export function applyBenchmarkPreset(
  id: BenchmarkPresetId,
  ctx: RecipeContext,
  nextId: () => string,
): AppliedBenchmarkPreset {
  if (id === "cloud-compare") {
    const source: RecipeSourceId = "dummy";
    const encoder: RecipeEncoderId = "ffmpeg";
    const nextCtx = { ...ctx, source, encoder };
    return {
      source,
      encoder,
      endpoints: coerceRecipe(withIds(defaultRecipeEndpoints(nextCtx), nextId), nextCtx),
    };
  }
  if (id === "contribution-compare") {
    const source: RecipeSourceId = "webcam";
    const encoder: RecipeEncoderId = "ffmpeg";
    const nextCtx = { ...ctx, source, encoder };
    return {
      source,
      encoder,
      endpoints: coerceRecipe(contributionEndpoints(nextCtx, nextId), nextCtx),
    };
  }
  const source: RecipeSourceId = "browser_moq";
  const encoder: RecipeEncoderId = "browser";
  const nextCtx = { ...ctx, source, encoder };
  const specs = BROWSER4_OUTPUT_KEYS.map((key) => OPERATOR_OUTPUTS[key]);
  return {
    source,
    encoder,
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
