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
  cloudHostFromIngest,
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
  coerceRecipe,
  obsMoqSupported,
  comparisonStartTitle,
  recipeFanoutWarning,
  recipeIssue,
  webcamSixWayFanout,
  webcamSrtShouldUseRegionalMtx,
  uniqueEndpointsByPublishSlot,
  type RecipeContext,
  type RecipeEncoderId,
  type RecipeSourceId,
  type PublishProtocolId,
} from "./recipeSupport.ts";

const RECIPES: BenchmarkPresetId[] = [
  "protocol-compare",
  "cloud-compare",
  "contribution-compare",
  "webrtc-vs-moq",
  "build-your-own",
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

  it("treats East/Linode Zixi custom URLs as Zixi HTTP-TS, not Fast HLS", () => {
    const eastUrl = "srt://35.196.215.179:10080?mode=caller";
    const linodeUrl = "srt://45.33.68.151:10080?mode=caller";
    const centralUrl = "srt://35.222.33.58:10080?mode=caller";
    assert.equal(looksLikeZixiPublish(eastUrl), true);
    assert.equal(looksLikeZixiPublish(linodeUrl), true);
    assert.equal(
      looksLikeZixiPublish("srt://66.175.213.81:8890?streamid=publish:benchmark"),
      false,
    );
    const east = resolvePlaybackTarget({
      protocol: "srt",
      endpointUrl: eastUrl,
      ingestEndpointId: "custom",
    });
    assert.equal(east.engine, "mpegts");
    assert.match(east.url, /SRT%20Test\.ts/);
    assert.doesNotMatch(east.url, /SRT%20Test%20EC/);
    const linode = resolvePlaybackTarget({
      protocol: "srt",
      endpointUrl: linodeUrl,
      ingestEndpointId: "custom",
    });
    assert.equal(linode.engine, "mpegts");
    const central = resolvePlaybackTarget({
      protocol: "srt",
      endpointUrl: centralUrl,
      ingestEndpointId: "custom",
    });
    assert.equal(central.engine, "hls");
    assert.match(central.url, /playback\.m3u8/);
    assert.deepEqual(
      playbackModesForSelection("srt", "custom", eastUrl).map((item) => item.id),
      ["mpegts"],
    );
    assert.deepEqual(
      playbackModesForSelection("srt", "custom", linodeUrl).map((item) => item.id),
      ["mpegts"],
    );
    assert.deepEqual(
      playbackModesForSelection("srt", "custom", centralUrl).map((item) => item.id),
      ["hls", "mpegts"],
    );
  });

  it("cloud-compare RTMP BBB fans five dests: Zixi HTTP-TS plus unique-host MTX LL-HLS", () => {
    const applied = applyBenchmarkPreset("cloud-compare", ctx("bbb", "ffmpeg"), nextId(), {
      source: "bbb",
      encoder: "ffmpeg",
      protocol: "rtmp",
    });
    assert.equal(applied.endpoints.length, 5, String(applied.endpoints.map((item) => item.ingestEndpointId)));
    const byHost = Object.fromEntries(
      applied.endpoints.map((endpoint) => [cloudHostFromIngest(endpoint.ingestEndpointId), endpoint]),
    );
    assert.equal(byHost.gcp_central?.ingestEndpointId, "gcp_zixi");
    assert.equal(byHost.gcp_east?.ingestEndpointId, "gcp_east_zixi");
    assert.equal(byHost.linode_east?.ingestEndpointId, "linode_zixi");
    assert.equal(byHost.linode_central?.ingestEndpointId, "linode_central_mediamtx");
    assert.equal(byHost.linode_west?.ingestEndpointId, "linode_west_mediamtx");
    const playUrls: string[] = [];
    for (const endpoint of applied.endpoints) {
      const url = resolveEndpointUrl(endpoint, PROD_PRESETS);
      const target = resolvePlaybackTarget({
        protocol: "rtmp",
        endpointUrl: url,
        ingestEndpointId: endpoint.ingestEndpointId,
        playbackMode: endpoint.playbackMode,
      });
      playUrls.push(target.url);
      if (endpoint.ingestEndpointId.endsWith("_zixi")) {
        assert.equal(target.engine, "mpegts");
        assert.match(target.url, /:7777\/benchmark\.ts/);
        assert.doesNotMatch(target.url, /:8888/);
        assert.doesNotMatch(target.url, /173\.230\.155\.121/);
      } else {
        assert.equal(target.engine, "hls");
        assert.match(target.url, /:8888\/benchmark\/index\.m3u8/);
      }
    }
    assert.equal(new Set(playUrls).size, 5, String(playUrls));
    assert.equal(
      playUrls.filter((item) => item.includes("173.230.155.121:8888/benchmark/index.m3u8")).length,
      1,
    );
  });

  it("MediaMTX RTMP unique job path plays LL-HLS on the same host, not standing benchmark", () => {
    const target = resolvePlaybackTarget({
      protocol: "rtmp",
      endpointUrl: "rtmp://173.230.155.121:1935/benchmark-a1b2c3d4",
      ingestEndpointId: "linode_west_mediamtx",
      playbackMode: "ll-hls",
    });
    assert.equal(target.engine, "hls");
    assert.equal(target.url, "http://173.230.155.121:8888/benchmark-a1b2c3d4/index.m3u8");
    assert.doesNotMatch(target.url, /\/benchmark\/index\.m3u8/);
  });

  it("remaps a saved Fast HLS player off East Zixi before Start", () => {
    const coerced = coerceRecipe(
      [
        {
          id: "east",
          protocol: "srt",
          ingestEndpointId: "gcp_east_zixi",
          endpointUrl: "",
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: "hls",
          playbackDvr: false,
        },
      ],
      ctx("dummy", "ffmpeg"),
    );
    assert.equal(coerced[0]?.playbackMode, "mpegts");
    assert.equal(recipeIssue(coerced, ctx("dummy", "ffmpeg")), null);
  });
});

describe("recipeFanoutWarning", () => {
  it("does not surface webcam fan-out copy in the UI", () => {
    const two = [
      {
        id: "a",
        protocol: "srt" as const,
        ingestEndpointId: "gcp_east_zixi",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "mpegts" as const,
        playbackDvr: false,
      },
      {
        id: "b",
        protocol: "moq" as const,
        ingestEndpointId: "gcp_moq_relay_d18",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "moq" as const,
        playbackDvr: false,
      },
    ];
    assert.equal(recipeFanoutWarning(two, { source: "webcam", encoder: "ffmpeg" }), null);

    const six = [
      ...two,
      { ...two[0], id: "c", ingestEndpointId: "linode_zixi" },
      { ...two[0], id: "d", protocol: "rtmp" as const, ingestEndpointId: "gcp_zixi" },
      { ...two[1], id: "e", ingestEndpointId: "gcp_east_moq_relay_d18" },
      { ...two[1], id: "f", ingestEndpointId: "linode_moq_relay_d18" },
    ];
    assert.equal(recipeFanoutWarning(six, { source: "webcam", encoder: "ffmpeg" }), null);
    assert.equal(webcamSixWayFanout(six, { source: "webcam", encoder: "ffmpeg" }), true);
    assert.equal(webcamSixWayFanout(two, { source: "webcam", encoder: "ffmpeg" }), false);
    assert.equal(webcamSrtShouldUseRegionalMtx(six, { source: "webcam", encoder: "ffmpeg" }), true);
    assert.equal(webcamSrtShouldUseRegionalMtx(two, { source: "webcam", encoder: "ffmpeg" }), false);

    const sixIssue = recipeIssue(six, ctx("webcam", "ffmpeg"));
    assert.equal(sixIssue, null);
    assert.equal(recipeIssue(two, ctx("webcam", "ffmpeg")), null);
    assert.equal(recipeIssue(six, ctx("dummy", "ffmpeg")), null);

    const coercedSix = coerceRecipe(six, ctx("webcam", "ffmpeg"));
    const eastSrt = coercedSix.find((item) => item.id === "a");
    const linodeSrt = coercedSix.find((item) => item.id === "c");
    const centralRtmp = coercedSix.find((item) => item.id === "d");
    assert.equal(eastSrt?.ingestEndpointId, "gcp_east_mediamtx");
    assert.equal(eastSrt?.playbackMode, "ll-hls");
    assert.equal(linodeSrt?.ingestEndpointId, "linode_mediamtx");
    assert.equal(linodeSrt?.playbackMode, "ll-hls");
    assert.equal(centralRtmp?.ingestEndpointId, "gcp_zixi");
    assert.equal(recipeIssue(coercedSix, ctx("webcam", "ffmpeg")), null);
    assert.equal(
      uniqueEndpointsByPublishSlot(coercedSix, ctx("webcam", "ffmpeg")).length,
      coercedSix.length,
    );

    const soloEast = coerceRecipe([two[0]], ctx("webcam", "ffmpeg"));
    assert.equal(soloEast[0]?.ingestEndpointId, "gcp_east_zixi");
    assert.equal(soloEast[0]?.playbackMode, "mpegts");
    const twoCoerced = coerceRecipe(two, ctx("webcam", "ffmpeg"));
    assert.equal(twoCoerced[0]?.ingestEndpointId, "gcp_east_zixi");
    assert.equal(twoCoerced[0]?.playbackMode, "mpegts");

    assert.equal(
      recipeFanoutWarning(two.slice(1), { source: "webcam", encoder: "browser" }),
      null,
    );

    assert.equal(recipeFanoutWarning(two, { source: "dummy", encoder: "ffmpeg" }), null);
  });

  it("webcam SRT remap keeps unique slots when the sibling MTX is occupied", () => {
    const collision = [
      {
        id: "east-zixi",
        protocol: "srt" as const,
        ingestEndpointId: "gcp_east_zixi",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "mpegts" as const,
        playbackDvr: false,
      },
      {
        id: "east-mtx",
        protocol: "srt" as const,
        ingestEndpointId: "gcp_east_mediamtx",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "ll-hls" as const,
        playbackDvr: false,
      },
      {
        id: "west-moq",
        protocol: "moq" as const,
        ingestEndpointId: "gcp_moq_relay_d18",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "moq" as const,
        playbackDvr: false,
      },
    ];
    const coerced = coerceRecipe(collision, ctx("webcam", "ffmpeg"));
    const eastZixi = coerced.find((item) => item.id === "east-zixi");
    const eastMtx = coerced.find((item) => item.id === "east-mtx");
    assert.ok(eastZixi);
    assert.ok(eastMtx);
    assert.notEqual(eastZixi?.ingestEndpointId, "gcp_east_mediamtx");
    assert.equal(eastMtx?.ingestEndpointId, "gcp_east_mediamtx");
    assert.equal(recipeIssue(coerced, ctx("webcam", "ffmpeg")), null);
    assert.equal(
      uniqueEndpointsByPublishSlot(coerced, ctx("webcam", "ffmpeg")).length,
      coerced.length,
    );
  });
});

describe("cloud-compare webcam Start gate", () => {
  for (const protocol of CLOUD_PROTOCOLS) {
    it(`webcam + ffmpeg + ${protocol} is recipe-legal; Start waits only on helper`, () => {
      const applied = applyBenchmarkPreset("cloud-compare", ctx("webcam", "ffmpeg"), nextId(), {
        source: "webcam",
        encoder: "ffmpeg",
        protocol,
      });
      assertStartable(`cloud-compare/webcam/ffmpeg/${protocol}`, "webcam", "ffmpeg", applied);
      const nextCtx = ctx(applied.source, applied.encoder);
      assert.equal(recipeIssue(applied.endpoints, nextCtx), null);
      assert.equal(recipeFanoutWarning(applied.endpoints, nextCtx), null);
      assert.equal(
        comparisonStartTitle({
          recipeIssue: recipeIssue(applied.endpoints, nextCtx),
          apiOnline: true,
          endpointCount: applied.endpoints.length,
          source: applied.source,
          encoder: applied.encoder,
          helperConnected: true,
          bbbAvailable: true,
          mediaPath: "device:webcam",
          browserCanStart: true,
        }),
        undefined,
      );
      const helperTitle = comparisonStartTitle({
        recipeIssue: null,
        apiOnline: true,
        endpointCount: applied.endpoints.length,
        source: applied.source,
        encoder: applied.encoder,
        helperConnected: false,
        bbbAvailable: true,
        mediaPath: "device:webcam",
        browserCanStart: true,
      });
      assert.match(helperTitle ?? "", /local publisher agent/i);
    });
  }

  it("cloud-playout MoQ Start is not helper-gated", () => {
    const applied = applyBenchmarkPreset("cloud-compare", ctx("dummy", "ffmpeg"), nextId(), {
      source: "dummy",
      encoder: "ffmpeg",
      protocol: "moq",
    });
    assert.equal(recipeIssue(applied.endpoints, ctx("dummy", "ffmpeg")), null);
    assert.equal(
      comparisonStartTitle({
        recipeIssue: null,
        apiOnline: true,
        endpointCount: applied.endpoints.length,
        source: "dummy",
        encoder: "ffmpeg",
        helperConnected: false,
        bbbAvailable: true,
      }),
      undefined,
    );
  });
});

describe("protocol-compare SRT default (prod presets)", () => {
  it("defaults SRT to MediaMTX LL-HLS, not Central Zixi HTTP-TS", () => {
    const applied = applyBenchmarkPreset("protocol-compare", ctx("dummy", "ffmpeg"), nextId(), {
      source: "dummy",
      encoder: "ffmpeg",
    });
    const srt = applied.endpoints.find((item) => item.protocol === "srt");
    const webrtc = applied.endpoints.find((item) => item.protocol === "webrtc");
    assert.ok(srt?.ingestEndpointId.endsWith("_mediamtx"), srt?.ingestEndpointId);
    assert.equal(srt?.playbackMode, "ll-hls");
    assert.notEqual(srt?.ingestEndpointId, "gcp_zixi");
    assert.notEqual(srt?.ingestEndpointId, webrtc?.ingestEndpointId);

    const custom = applyBenchmarkPreset("build-your-own", ctx("dummy", "ffmpeg"), nextId());
    const customSrt = custom.endpoints.find((item) => item.protocol === "srt");
    assert.ok(customSrt?.ingestEndpointId.endsWith("_mediamtx"), customSrt?.ingestEndpointId);
    assert.equal(customSrt?.playbackMode, "ll-hls");
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
