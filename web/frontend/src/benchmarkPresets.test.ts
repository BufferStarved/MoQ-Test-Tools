import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyBenchmarkPreset,
  BENCHMARK_PRESET_DEFS,
  benchmarkPresetLegal,
  recipeLockedSummary,
  recipeNeedsLaptopHelper,
  recipeLocksEndpoints,
  recipeLocksProtocolMix,
  recipeLocksStep,
  recipeRevealsLockedOutputs,
  recipeShowsEndpointPickers,
  recipeShowsSharedProtocolPicker,
  wizardStepVisible,
} from "./benchmarkPresets.ts";
import { RECIPE_HIDDEN_INGEST_IDS, cloudHostFromIngest } from "./ingestEndpoints.ts";
import { RECIPE_CHROME_CAPS, type RecipeContext } from "./recipeSupport.ts";
import { TEST_SCOPE_E2E, TEST_SCOPE_UPLOAD } from "./testScope.ts";
import type { EndpointConfig, Preset } from "./types.ts";

const chromeCtx = (
  source: RecipeContext["source"] = "dummy",
  extras: Partial<RecipeContext> = {},
): RecipeContext => ({
  source,
  presets: extras.presets ?? [],
  caps: RECIPE_CHROME_CAPS,
  encoder: extras.encoder,
  publisher: extras.publisher,
});

function nextId() {
  let n = 0;
  return () => `id-${++n}`;
}

function stubPreset(id: string): Preset {
  return {
    id,
    name: id,
    protocol: "srt",
    notes: "",
    env_vars: [],
    requires_env: false,
    web_available: true,
    url: `https://example.test/${id}`,
  };
}

const EAST_PRESETS: Preset[] = [
  stubPreset("moq_zixi_gcp"),
  stubPreset("moq_zixi_gcp_rtmp"),
  stubPreset("moq_mediamtx_gcp_srt"),
  stubPreset("moq_mediamtx_gcp_whip"),
  stubPreset("moq_gcp_relay_d18"),
  stubPreset("moq_zixi_gcp_east"),
  stubPreset("moq_zixi_gcp_east_rtmp"),
  stubPreset("moq_mediamtx_gcp_east_srt"),
  stubPreset("moq_mediamtx_gcp_east_whip"),
  stubPreset("moq_gcp_east_relay_d18"),
];

const WIRED_PRESETS: Preset[] = [
  ...EAST_PRESETS,
  stubPreset("moq_zixi_linode"),
  stubPreset("moq_zixi_linode_rtmp"),
  stubPreset("moq_mediamtx_linode_srt"),
  stubPreset("moq_mediamtx_linode_whip"),
  stubPreset("moq_linode_relay_d18"),
];

function assertPublicMoq(endpoints: { protocol: string; ingestEndpointId: string }[]) {
  for (const endpoint of endpoints.filter((item) => item.protocol === "moq")) {
    assert.ok(
      endpoint.ingestEndpointId.endsWith("_moq_relay_d18"),
      `leftover :4433 ingest ${endpoint.ingestEndpointId}`,
    );
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has(endpoint.ingestEndpointId), false);
  }
}

describe("applyBenchmarkPreset", () => {
  it("cloud-compare is e2e with one protocol on every region tile", () => {
    const plan = applyBenchmarkPreset("cloud-compare", chromeCtx("dummy"), nextId());
    assert.equal(plan.source, "dummy");
    assert.equal(plan.encoder, "ffmpeg");
    assert.equal(plan.testScope, TEST_SCOPE_E2E);
    assert.ok(plan.endpoints.length >= 2, String(plan.endpoints.map((item) => item.ingestEndpointId)));
    const protocols = new Set(plan.endpoints.map((endpoint) => endpoint.protocol));
    assert.equal(protocols.size, 1);
    assert.equal(plan.endpoints[0]?.protocol, "srt");
    const hosts = new Set(plan.endpoints.map((endpoint) => cloudHostFromIngest(endpoint.ingestEndpointId)));
    assert.ok(hosts.size >= 2, String([...hosts]));
    assert.equal(
      plan.endpoints.some((endpoint) =>
        cloudHostFromIngest(endpoint.ingestEndpointId).startsWith("aws"),
      ),
      false,
    );
    assertPublicMoq(plan.endpoints);
    assert.equal(benchmarkPresetLegal(plan, chromeCtx("dummy")), true);
  });

  it("cloud-compare keeps a requested protocol and never offers leftover :4433 or AWS", () => {
    const plan = applyBenchmarkPreset(
      "cloud-compare",
      chromeCtx("dummy", { presets: EAST_PRESETS }),
      nextId(),
      { protocol: "moq" },
    );
    assert.ok(plan.endpoints.length >= 2);
    assert.ok(plan.endpoints.every((endpoint) => endpoint.protocol === "moq"));
    assertPublicMoq(plan.endpoints);
    assert.equal(
      plan.endpoints.some((endpoint) => endpoint.ingestEndpointId.includes("moq_relay") && !endpoint.ingestEndpointId.endsWith("_d18")),
      false,
    );
    assert.equal(
      plan.endpoints.some((endpoint) =>
        cloudHostFromIngest(endpoint.ingestEndpointId).startsWith("aws"),
      ),
      false,
    );
    const hosts = new Set(plan.endpoints.map((endpoint) => cloudHostFromIngest(endpoint.ingestEndpointId)));
    assert.ok(hosts.size === plan.endpoints.length, String([...hosts]));
  });

  it("cloud-compare seeds the three wired clouds when those relays exist", () => {
    const plan = applyBenchmarkPreset(
      "cloud-compare",
      chromeCtx("dummy", { presets: WIRED_PRESETS }),
      nextId(),
      { protocol: "webrtc" },
    );
    assert.equal(plan.endpoints.length, 3);
    assert.ok(plan.endpoints.every((endpoint) => endpoint.protocol === "webrtc"));
    assert.deepEqual(
      plan.endpoints.map((endpoint) => cloudHostFromIngest(endpoint.ingestEndpointId)).sort(),
      ["gcp_central", "gcp_east", "linode_east"].sort(),
    );
    assert.ok(plan.endpoints.every((endpoint) => endpoint.ingestEndpointId.endsWith("_mediamtx")));
    assert.equal(
      plan.endpoints.some((endpoint) => endpoint.ingestEndpointId.startsWith("aws_")),
      false,
    );
  });

  it("cloud-compare keeps a user-picked webcam or browser source", () => {
    const webcam = applyBenchmarkPreset("cloud-compare", chromeCtx("webcam"), nextId(), {
      source: "webcam",
    });
    assert.equal(webcam.source, "webcam");
    assert.equal(webcam.encoder, "ffmpeg");
    assert.ok(webcam.endpoints.every((endpoint) => endpoint.protocol === "srt"));

    const browser = applyBenchmarkPreset("cloud-compare", chromeCtx("browser_moq"), nextId(), {
      source: "browser_moq",
      encoder: "browser",
    });
    assert.equal(browser.source, "browser_moq");
    assert.equal(browser.encoder, "browser");
    assert.ok(browser.endpoints.length >= 1);
    assert.ok(
      browser.endpoints.every((endpoint) => endpoint.protocol === "moq" || endpoint.protocol === "webrtc"),
    );
    const browserProtocols = new Set(browser.endpoints.map((endpoint) => endpoint.protocol));
    assert.equal(browserProtocols.size, 1);
    assertPublicMoq(browser.endpoints);
  });

  it("contribution-compare is webcam upload-only and still publishes MoQ on :14433", () => {
    const plan = applyBenchmarkPreset("contribution-compare", chromeCtx("webcam"), nextId());
    assert.equal(plan.source, "webcam");
    assert.equal(plan.encoder, "ffmpeg");
    assert.equal(plan.testScope, TEST_SCOPE_UPLOAD);
    assert.ok(plan.endpoints.length >= 2);
    assert.deepEqual(
      plan.endpoints.map((endpoint) => endpoint.protocol).sort(),
      ["moq", "rtmp", "srt"],
    );
    assertPublicMoq(plan.endpoints);
  });

  it("contribution-compare reuses the last-used cloud and still skips leftover :4433", () => {
    const current: EndpointConfig[] = [
      {
        id: "prev",
        protocol: "srt",
        ingestEndpointId: "gcp_east_zixi",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "hls",
        playbackDvr: false,
      },
    ];
    const plan = applyBenchmarkPreset(
      "contribution-compare",
      chromeCtx("webcam", { presets: EAST_PRESETS }),
      nextId(),
      { currentEndpoints: current },
    );
    assert.deepEqual(
      plan.endpoints.map((endpoint) => endpoint.protocol).sort(),
      ["moq", "rtmp", "srt"],
    );
    assert.ok(
      plan.endpoints.every((endpoint) => endpoint.ingestEndpointId.startsWith("gcp_east_")),
      String(plan.endpoints.map((item) => item.ingestEndpointId)),
    );
    assertPublicMoq(plan.endpoints);
  });

  it("contribution-compare keeps cloud playout / VOD when the user picks it", () => {
    const plan = applyBenchmarkPreset("contribution-compare", chromeCtx("dummy"), nextId(), {
      source: "dummy",
    });
    assert.equal(plan.source, "dummy");
    assert.equal(plan.encoder, "ffmpeg");
    assert.equal(plan.testScope, TEST_SCOPE_UPLOAD);
    assert.ok(plan.endpoints.some((endpoint) => endpoint.protocol === "srt"));
    assert.ok(plan.endpoints.some((endpoint) => endpoint.protocol === "rtmp"));
    assert.ok(plan.endpoints.some((endpoint) => endpoint.protocol === "moq"));
    assertPublicMoq(plan.endpoints);
  });

  it("contribution-compare does not treat Browser as a source", () => {
    const plan = applyBenchmarkPreset("contribution-compare", chromeCtx("browser_moq"), nextId(), {
      source: "browser_moq",
      encoder: "browser",
    });
    assert.equal(plan.source, "webcam");
    assert.equal(plan.encoder, "ffmpeg");
    assert.equal(plan.testScope, TEST_SCOPE_UPLOAD);
  });

  it("webrtc-vs-moq is browser e2e on d18 + WHEP", () => {
    const plan = applyBenchmarkPreset("webrtc-vs-moq", chromeCtx("webcam"), nextId());
    assert.equal(plan.source, "browser_moq");
    assert.equal(plan.encoder, "browser");
    assert.equal(plan.testScope, TEST_SCOPE_E2E);
    assert.ok(plan.endpoints.every((endpoint) => endpoint.protocol === "moq" || endpoint.protocol === "webrtc"));
    assertPublicMoq(plan.endpoints);
  });

  it("protocol-compare is e2e 4-way SRT + RTMP + WHIP + public MoQ", () => {
    const plan = applyBenchmarkPreset("protocol-compare", chromeCtx("dummy"), nextId());
    assert.equal(plan.source, "dummy");
    assert.equal(plan.encoder, "ffmpeg");
    assert.equal(plan.testScope, TEST_SCOPE_E2E);
    const protocols = plan.endpoints.map((endpoint) => endpoint.protocol);
    assert.deepEqual(protocols.sort(), ["moq", "rtmp", "srt", "webrtc"].sort());
    assertPublicMoq(plan.endpoints);
    assert.equal(
      plan.endpoints.some((endpoint) =>
        cloudHostFromIngest(endpoint.ingestEndpointId).startsWith("aws"),
      ),
      false,
    );
    const webrtc = plan.endpoints.find((endpoint) => endpoint.protocol === "webrtc");
    const moq = plan.endpoints.find((endpoint) => endpoint.protocol === "moq");
    assert.equal(webrtc?.playbackMode, "whep");
    assert.equal(moq?.playbackMode, "moq");
    assert.equal(benchmarkPresetLegal(plan, chromeCtx("dummy")), true);
  });

  it("protocol-compare reuses the last-used cloud and still skips AWS", () => {
    const current: EndpointConfig[] = [
      {
        id: "prev",
        protocol: "srt",
        ingestEndpointId: "gcp_east_zixi",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "hls",
        playbackDvr: false,
      },
    ];
    const plan = applyBenchmarkPreset(
      "protocol-compare",
      chromeCtx("dummy", { presets: EAST_PRESETS }),
      nextId(),
      { currentEndpoints: current },
    );
    assert.ok(plan.endpoints.length === 4, String(plan.endpoints.map((item) => item.ingestEndpointId)));
    assert.ok(
      plan.endpoints.every((endpoint) => endpoint.ingestEndpointId.startsWith("gcp_east_")),
      String(plan.endpoints.map((item) => item.ingestEndpointId)),
    );
    assert.equal(
      plan.endpoints.some((endpoint) => endpoint.ingestEndpointId.startsWith("aws_")),
      false,
    );
    assertPublicMoq(plan.endpoints);
  });

  it("build-your-own keeps the current form and does not mask outputs", () => {
    const current: EndpointConfig[] = [
      {
        id: "keep",
        protocol: "srt",
        ingestEndpointId: "gcp_zixi",
        endpointUrl: "",
        vmafAvailable: false,
        serverMetricsAvailable: false,
        playbackMode: "hls",
        playbackDvr: false,
      },
    ];
    const plan = applyBenchmarkPreset("build-your-own", chromeCtx("bbb", { encoder: "ffmpeg" }), nextId(), {
      currentEndpoints: current,
      currentTestScope: TEST_SCOPE_UPLOAD,
    });
    assert.equal(plan.source, "bbb");
    assert.equal(plan.testScope, TEST_SCOPE_UPLOAD);
    assert.equal(plan.endpoints[0]?.id, "keep");
    assert.equal(wizardStepVisible("build-your-own", "outputs"), true);
    assert.equal(wizardStepVisible("build-your-own", "source"), true);
    assert.equal(recipeLockedSummary("build-your-own"), null);
  });

  it("build-your-own defaults include a public MoQ :14433 tile", () => {
    const plan = applyBenchmarkPreset("build-your-own", chromeCtx("dummy"), nextId());
    assert.ok(plan.endpoints.some((endpoint) => endpoint.protocol === "moq"));
    assert.ok(plan.endpoints.some((endpoint) => endpoint.protocol === "srt"));
    assertPublicMoq(plan.endpoints);
  });
});

describe("recipe wizard locks", () => {
  it("lists recipes in the visitor order, Custom first", () => {
    assert.deepEqual(
      BENCHMARK_PRESET_DEFS.map((item) => item.id),
      [
        "build-your-own",
        "contribution-compare",
        "webrtc-vs-moq",
        "protocol-compare",
        "cloud-compare",
      ],
    );
    assert.deepEqual(
      BENCHMARK_PRESET_DEFS.map((item) => [item.label, item.hint]),
      [
        ["Build your own", "You pick the source, destinations, and players."],
        [
          "Ingest comparison",
          "Contribution and acquisition performance across clouds and protocols",
        ],
        ["Webcam Browsers", "Webcam & WebCodecs API protocol comparison"],
        [
          "Protocol Comparison",
          "Compare SRT, RTMP, WebRTC and MoQ upload and playback (HLS playback for SRT/RTMP uploads)",
        ],
        [
          "Cloud/Edge Comparison",
          "Compare upload and delivery performance of the same protocols across multiple infrastructure providers and regions",
        ],
      ],
    );
  });

  it("hides later steps until a recipe is picked", () => {
    assert.equal(wizardStepVisible(null, "outputs"), false);
    assert.equal(wizardStepVisible(null, "source"), false);
    assert.equal(wizardStepVisible(null, "testScope"), false);
  });

  it("protocol-compare masks outputs and scope, keeps source", () => {
    assert.equal(recipeLocksStep("protocol-compare", "outputs"), true);
    assert.equal(recipeLocksStep("protocol-compare", "testScope"), true);
    assert.equal(wizardStepVisible("protocol-compare", "outputs"), false);
    assert.equal(wizardStepVisible("protocol-compare", "source"), true);
    assert.equal(wizardStepVisible("protocol-compare", "encoder"), true);
    assert.match(recipeLockedSummary("protocol-compare") ?? "", /HLS playback/);
  });

  it("contribution-compare unlocks source and endpoint pickers; protocol mix stays locked", () => {
    assert.equal(recipeLocksStep("contribution-compare", "source"), false);
    assert.equal(wizardStepVisible("contribution-compare", "source"), true);
    assert.equal(wizardStepVisible("contribution-compare", "testScope"), false);
    assert.equal(wizardStepVisible("contribution-compare", "encoder"), false);
    assert.equal(wizardStepVisible("contribution-compare", "outputs"), false);
    assert.equal(recipeShowsEndpointPickers("contribution-compare"), true);
    assert.equal(recipeShowsEndpointPickers("protocol-compare"), false);
    assert.equal(recipeShowsEndpointPickers("cloud-compare"), true);
    assert.equal(recipeShowsEndpointPickers("build-your-own"), true);
    assert.equal(recipeShowsEndpointPickers(null), false);
    assert.equal(recipeLocksProtocolMix("contribution-compare"), true);
    assert.equal(recipeLocksProtocolMix("cloud-compare"), true);
    assert.equal(recipeLocksEndpoints("contribution-compare"), false);
    assert.equal(recipeLocksEndpoints("cloud-compare"), false);
    assert.equal(recipeShowsSharedProtocolPicker("cloud-compare"), true);
    assert.equal(recipeShowsSharedProtocolPicker("contribution-compare"), false);
    assert.match(recipeLockedSummary("contribution-compare") ?? "", /Encode and ingest meters only/);
    assert.doesNotMatch(recipeLockedSummary("contribution-compare") ?? "", /webcam upload-only/);
    assert.equal(recipeNeedsLaptopHelper("contribution-compare"), true);
    assert.equal(recipeNeedsLaptopHelper("webrtc-vs-moq"), false);
    assert.equal(recipeNeedsLaptopHelper("cloud-compare"), false);
  });

  it("cloud-compare unlocks source and region tiles; protocol mix stays one shared picker", () => {
    assert.equal(wizardStepVisible("cloud-compare", "source"), true);
    assert.equal(wizardStepVisible("cloud-compare", "outputs"), true);
    assert.equal(wizardStepVisible("cloud-compare", "testScope"), false);
    assert.equal(recipeLocksProtocolMix("cloud-compare"), true);
    assert.equal(recipeLocksEndpoints("cloud-compare"), false);
    assert.equal(recipeShowsSharedProtocolPicker("cloud-compare"), true);
    assert.match(recipeLockedSummary("cloud-compare") ?? "", /One protocol, compared across live clouds/);
  });

  it("locked-output recipes reveal tiles before Start; Custom does not", () => {
    assert.equal(recipeRevealsLockedOutputs("webrtc-vs-moq"), true);
    assert.equal(recipeRevealsLockedOutputs("protocol-compare"), true);
    assert.equal(recipeRevealsLockedOutputs("contribution-compare"), false);
    assert.equal(recipeRevealsLockedOutputs("build-your-own"), false);
    assert.equal(recipeRevealsLockedOutputs(null), false);
  });

  it("precanned recipes mask shape steps and keep a locked summary", () => {
    for (const id of ["webrtc-vs-moq"] as const) {
      assert.equal(wizardStepVisible(id, "outputs"), false);
      assert.equal(wizardStepVisible(id, "source"), false);
      assert.ok(recipeLockedSummary(id));
    }
  });
});
