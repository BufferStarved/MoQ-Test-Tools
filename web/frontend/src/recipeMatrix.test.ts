/**
 * Every visitor recipe × source × encoder × shared protocol, using the
 * live prod preset list. No Chrome. This is the Start-button contract:
 * legal plan, unique publish slots, resolved URL, playable target.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyBenchmarkPreset,
  benchmarkPresetLegal,
  type BenchmarkPresetId,
} from "./benchmarkPresets.ts";
import { PROD_PRESETS } from "./fixtures/prodPresets.ts";
import {
  RECIPE_HIDDEN_INGEST_IDS,
  ingestEndpointIdForPreset,
  resolveEndpointUrl,
} from "./ingestEndpoints.ts";
import {
  looksLikeZixiPublish,
  playbackModesForSelection,
  resolvePlaybackTarget,
} from "./playbackUrls.ts";
import {
  RECIPE_CHROME_CAPS,
  obsMoqSupported,
  recipeIssue,
  uniqueEndpointsByPublishSlot,
  type RecipeContext,
  type RecipeEncoderId,
  type RecipeSourceId,
  type PublishProtocolId,
} from "./recipeSupport.ts";

const RECIPES: BenchmarkPresetId[] = [
  "build-your-own",
  "protocol-compare",
  "cloud-compare",
  "contribution-compare",
  "webrtc-vs-moq",
];

const SOURCES: RecipeSourceId[] = ["dummy", "bbb", "upload", "webcam", "browser_moq"];
const ENCODERS: RecipeEncoderId[] = ["ffmpeg", "obs", "browser"];
const CLOUD_PROTOCOLS: PublishProtocolId[] = ["srt", "rtmp", "webrtc", "moq"];

function nextId() {
  let n = 0;
  return () => `ep-${++n}`;
}

function ctx(source: RecipeSourceId, encoder: RecipeEncoderId): RecipeContext {
  return {
    source,
    encoder,
    presets: PROD_PRESETS,
    caps: RECIPE_CHROME_CAPS,
    publisher: { localFfmpegWhip: true },
  };
}

function assertStartable(
  label: string,
  source: RecipeSourceId,
  encoder: RecipeEncoderId,
  applied: ReturnType<typeof applyBenchmarkPreset>,
) {
  const nextCtx = ctx(applied.source, applied.encoder);
  const issue = recipeIssue(applied.endpoints, nextCtx);
  assert.equal(issue, null, `${label}: recipeIssue=${issue}`);
  assert.equal(benchmarkPresetLegal(applied, nextCtx), true, `${label}: illegal`);
  assert.ok(applied.endpoints.length > 0, `${label}: no tiles`);
  const unique = uniqueEndpointsByPublishSlot(applied.endpoints, nextCtx);
  assert.equal(
    unique.length,
    applied.endpoints.length,
    `${label}: Start would drop tiles (${applied.endpoints.length} → ${unique.length})`,
  );
  for (const endpoint of applied.endpoints) {
    assert.equal(
      RECIPE_HIDDEN_INGEST_IDS.has(endpoint.ingestEndpointId),
      false,
      `${label}: leftover :4433 ${endpoint.ingestEndpointId}`,
    );
    assert.equal(
      endpoint.ingestEndpointId.includes("aws_"),
      false,
      `${label}: invented AWS ${endpoint.ingestEndpointId}`,
    );
    const url = resolveEndpointUrl(endpoint, PROD_PRESETS);
    assert.ok(url, `${label}: empty publish URL ${endpoint.protocol} ${endpoint.ingestEndpointId}`);
    assert.equal(url.includes(":4433") && !url.includes(":14433"), false, `${label}: :4433 URL ${url}`);
    if (applied.testScope === "upload") {
      continue;
    }
    const target = resolvePlaybackTarget({
      protocol: endpoint.protocol,
      endpointUrl: url,
      ingestEndpointId: endpoint.ingestEndpointId,
      playbackMode: endpoint.playbackMode,
    });
    assert.notEqual(
      target.engine,
      "unsupported",
      `${label}: unplayable ${endpoint.protocol} ${endpoint.ingestEndpointId} ${target.note ?? ""}`,
    );
    if (endpoint.protocol === "moq") {
      assert.equal(target.engine, "moq");
      assert.match(target.url, /:14433/);
    }
  }
}

describe("live preset snapshot", () => {
  it("includes unavailable West/AWS dests so recipes cannot invent them", () => {
    const west = PROD_PRESETS.find((preset) => preset.id === "moq_gcp_west_relay_d18");
    const aws = PROD_PRESETS.find((preset) => preset.id === "moq_aws_east_relay_d18");
    assert.ok(west);
    assert.equal(west?.web_available, false);
    assert.ok(aws);
    assert.equal(aws?.web_available, false);
  });
});

describe("recipeIssue with loaded presets", () => {
  it("blocks a managed dest that has no publish URL", () => {
    const empty = {
      ...PROD_PRESETS.find((preset) => preset.id === "moq_mediamtx_gcp_east_rtmp")!,
      url: "",
    };
    const issue = recipeIssue(
      [
        {
          id: "east-rtmp",
          protocol: "rtmp",
          ingestEndpointId: "gcp_east_mediamtx",
          endpointUrl: "",
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: "ll-hls",
          playbackDvr: false,
        },
      ],
      { ...ctx("dummy", "ffmpeg"), presets: [empty] },
    );
    assert.match(issue ?? "", /not deployed/i);
  });
});

describe("OBS on public draft-18", () => {
  it("does not treat Custom as a live OBS MoQ dest", () => {
    assert.equal(obsMoqSupported(ctx("webcam", "obs")), false);
    const applied = applyBenchmarkPreset("protocol-compare", ctx("webcam", "obs"), nextId(), {
      source: "webcam",
      encoder: "obs",
    });
    assert.match(
      recipeIssue(applied.endpoints, ctx("webcam", "obs")) ?? "",
      /draft-16 only/i,
    );
    assert.doesNotMatch(
      recipeIssue(applied.endpoints, ctx("webcam", "obs")) ?? "",
      /needs a MoQ output/i,
    );
  });
});

describe("every prod dest × playback mode", () => {
  it("resolves a playable target and never leftover :4433", () => {
    for (const preset of PROD_PRESETS) {
      if (!preset.web_available || !preset.url) {
        continue;
      }
      const ingest = ingestEndpointIdForPreset(preset.id);
      if (RECIPE_HIDDEN_INGEST_IDS.has(ingest)) {
        continue;
      }
      const protocol = preset.protocol;
      const modes = playbackModesForSelection(protocol, ingest);
      assert.ok(modes.length > 0, `${preset.id}: no playback modes`);
      for (const mode of modes) {
        const target = resolvePlaybackTarget({
          protocol,
          endpointUrl: preset.url,
          ingestEndpointId: ingest,
          playbackMode: mode.id,
        });
        assert.notEqual(
          target.engine,
          "unsupported",
          `${preset.id} ${mode.id}: ${target.note ?? ""}`,
        );
        assert.ok(target.url, `${preset.id} ${mode.id}: empty play URL`);
        assert.equal(
          target.url.includes(":4433") && !target.url.includes(":14433"),
          false,
          `${preset.id} ${mode.id}: ${target.url}`,
        );
        if (protocol === "moq") {
          assert.equal(target.engine, "moq");
          assert.match(target.url, /:14433/);
        }
        if (ingest.endsWith("_mediamtx") && (mode.id === "hls" || mode.id === "ll-hls")) {
          assert.match(target.url, /:8888\/benchmark\/index\.m3u8/);
        }
        if (ingest.endsWith("_zixi") && protocol === "srt") {
          assert.match(target.url, /SRT%20Test/);
          assert.doesNotMatch(target.url, /SRT%20Test%20EC/);
        }
      }
    }
  });

  it("treats East/Linode Zixi custom URLs as Zixi, not MediaMTX", () => {
    assert.equal(looksLikeZixiPublish("srt://35.196.215.179:10080?mode=caller"), true);
    assert.equal(looksLikeZixiPublish("srt://45.33.68.151:10080?mode=caller"), true);
    assert.equal(
      looksLikeZixiPublish("srt://66.175.213.81:8890?streamid=publish:benchmark"),
      false,
    );
    const east = resolvePlaybackTarget({
      protocol: "srt",
      endpointUrl: "srt://35.196.215.179:10080?mode=caller",
      ingestEndpointId: "custom",
    });
    assert.equal(east.engine, "hls");
    assert.match(east.url, /SRT%20Test/);
    assert.doesNotMatch(east.url, /SRT%20Test%20EC/);
  });
});

describe("recipe matrix (prod presets)", () => {
  for (const recipe of RECIPES) {
    for (const source of SOURCES) {
      for (const encoder of ENCODERS) {
        if (recipe === "webrtc-vs-moq" && source !== "browser_moq" && encoder !== "browser") {
          // Recipe forces browser_moq + browser; other combos still apply.
        }
        if (recipe === "contribution-compare" && encoder !== "ffmpeg") {
          continue;
        }
        if (source === "webcam" && encoder === "obs") {
          continue;
        }
        it(`${recipe} source=${source} encoder=${encoder}`, () => {
          const applied = applyBenchmarkPreset(recipe, ctx(source, encoder), nextId(), {
            source,
            encoder,
          });
          assertStartable(`${recipe}/${source}/${encoder}`, source, encoder, applied);
        });
        if (recipe === "cloud-compare") {
          for (const protocol of CLOUD_PROTOCOLS) {
            it(`${recipe} source=${source} encoder=${encoder} protocol=${protocol}`, () => {
              const applied = applyBenchmarkPreset(recipe, ctx(source, encoder), nextId(), {
                source,
                encoder,
                protocol,
              });
              if (applied.endpoints.length === 0) {
                return;
              }
              assert.ok(
                applied.endpoints.every((endpoint) => endpoint.protocol === applied.endpoints[0]?.protocol),
                "cloud-compare mixed protocols",
              );
              assertStartable(
                `${recipe}/${source}/${encoder}/${protocol}`,
                source,
                encoder,
                applied,
              );
            });
          }
        }
      }
    }
  }
});
