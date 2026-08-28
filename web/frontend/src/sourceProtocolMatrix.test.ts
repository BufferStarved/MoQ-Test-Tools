/**
 * Source × protocol start map. A headed 4-way has not been run; these
 * tests pin which path starts encode, which player mounts, and which
 * hops apply so "works on laptop file" cannot silently break cloud
 * playout / webcam / browser.
 *
 *   source          encode                         SRT  RTMP  WHIP  MoQ :14433
 *   dummy/bbb/upload  server ffmpeg (cloud playout)  yes  yes   yes   CMAF
 *   webcam+ffmpeg     helper / broker (1s IDR copy)  yes  yes   yes*  CMAF
 *   webcam+solo       helper re-encode (0.25s GOP)   —    —     —    CMAF
 *   webcam+browser    in-tab WebCodecs / RTC         no   no    yes   LOC
 *   browser_moq       same as webcam+browser         no   no    yes   LOC
 *
 * *WHIP on webcam+ffmpeg needs laptop `-f whip`. Cloud WHIP does not.
 * Leftover :4433 is hidden. AWS is not offered.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBenchmarkPreset } from "./benchmarkPresets.ts";
import {
  isBrokeredWebcamMedia,
  moqGroupDurationMs,
  segmentationMsForPublish,
} from "./encodeProfiles.ts";
import { goLiveButtonVisible } from "./goLive.ts";
import { RECIPE_HIDDEN_INGEST_IDS, defaultIngestForProtocol } from "./ingestEndpoints.ts";
import { operatorBenchmarkPreset, parseOperatorSearch } from "./operatorRecipe.ts";
import { encoderSectionMoqGopNote } from "./pipelineConfig.ts";
import {
  isCloudPlayoutSource,
  isLocalAgentSource,
  publishProtocolIdsForSource,
  RECIPE_CHROME_CAPS,
  recipeEncoderForSource,
  recipeIssue,
  type RecipeContext,
} from "./recipeSupport.ts";
import { playbackPolicyToggleVisible } from "./playbackPolicy.ts";
import { TEST_SCOPE_E2E, TEST_SCOPE_UPLOAD, canOverlayTestScopes } from "./testScope.ts";

const ctx = (source: RecipeContext["source"], encoder: RecipeContext["encoder"] = "ffmpeg"): RecipeContext => ({
  source,
  encoder,
  presets: [],
  caps: RECIPE_CHROME_CAPS,
});

function nextId() {
  let n = 0;
  return () => `ep-${++n}`;
}

describe("source × protocol start map", () => {
  it("treats dummy / bbb / upload as cloud playout (server ffmpeg)", () => {
    for (const source of ["dummy", "bbb", "upload"] as const) {
      assert.equal(isCloudPlayoutSource(source), true);
      assert.equal(isLocalAgentSource(source), false);
      assert.equal(recipeEncoderForSource(source, "obs"), "ffmpeg");
      assert.equal(recipeEncoderForSource(source, "browser"), "ffmpeg");
      assert.deepEqual(publishProtocolIdsForSource(source, RECIPE_CHROME_CAPS), [
        "srt",
        "rtmp",
        "webrtc",
        "moq",
      ]);
    }
  });

  it("keeps webcam on the laptop helper; browser is MoQ + WebRTC only", () => {
    assert.equal(isLocalAgentSource("webcam"), true);
    assert.deepEqual(publishProtocolIdsForSource("webcam", RECIPE_CHROME_CAPS, undefined, "ffmpeg"), [
      "srt",
      "rtmp",
      "webrtc",
      "moq",
    ]);
    assert.deepEqual(publishProtocolIdsForSource("webcam", RECIPE_CHROME_CAPS, undefined, "browser"), [
      "moq",
      "webrtc",
    ]);
    assert.deepEqual(publishProtocolIdsForSource("browser_moq", RECIPE_CHROME_CAPS), ["moq", "webrtc"]);
  });

  it("defaults every cloud to public MoQ :14433, never leftover :4433", () => {
    for (const host of ["gcp_central", "gcp_east", "linode_east"] as const) {
      const ingest = defaultIngestForProtocol("moq", host);
      assert.ok(ingest.endsWith("_moq_relay_d18"), ingest);
      assert.equal(RECIPE_HIDDEN_INGEST_IDS.has(ingest), false);
    }
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has("gcp_moq_relay"), true);
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has("gcp_east_moq_relay"), true);
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has("linode_moq_relay"), true);
  });

  it("does not invent AWS as a live dest", () => {
    const issue = recipeIssue(
      [
        {
          id: "aws",
          protocol: "srt",
          ingestEndpointId: "aws_east_zixi",
          endpointUrl: "",
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: "hls",
          playbackDvr: false,
        },
      ],
      ctx("dummy"),
    );
    assert.match(issue ?? "", /destination is not supported/i);
  });

  it("blocks a custom WHIP that duplicates a preset path", () => {
    const whip = "http://66.175.213.81:8889/benchmark/whip";
    const issue = recipeIssue(
      [
        {
          id: "preset",
          protocol: "webrtc",
          ingestEndpointId: "linode_mediamtx",
          endpointUrl: "",
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: "whep",
          playbackDvr: false,
        },
        {
          id: "custom",
          protocol: "webrtc",
          ingestEndpointId: "custom",
          endpointUrl: whip,
          vmafAvailable: false,
          serverMetricsAvailable: false,
          playbackMode: "whep",
          playbackDvr: false,
        },
      ],
      {
        ...ctx("bbb"),
        presets: [
          {
            id: "moq_mediamtx_linode_whip",
            name: "Linode WHIP",
            protocol: "webrtc",
            url: whip,
            notes: "",
            env_vars: [],
            requires_env: false,
            web_available: true,
          },
        ],
      },
    );
    assert.match(issue ?? "", /same ingest path/i);
  });
});

describe("test_scope and playback policy per source", () => {
  it("shows live-edge vs complete for file, cloud playout, and webcam (not WebRTC-only)", () => {
    assert.equal(playbackPolicyToggleVisible(["srt", "moq"]), true);
    assert.equal(playbackPolicyToggleVisible(["srt", "rtmp", "moq"]), true);
    assert.equal(playbackPolicyToggleVisible(["webrtc"]), false);
    assert.equal(playbackPolicyToggleVisible(["webrtc", "moq"]), true);
  });

  it("keeps Cloud compare on e2e with one protocol and distinct :14433-safe regions", () => {
    const plan = applyBenchmarkPreset("cloud-compare", ctx("dummy"), nextId());
    assert.equal(plan.source, "dummy");
    assert.equal(plan.testScope, TEST_SCOPE_E2E);
    const protocols = new Set(plan.endpoints.map((endpoint) => endpoint.protocol));
    assert.equal(protocols.size, 1);
    assert.ok(plan.endpoints.length >= 2);
    const moq = applyBenchmarkPreset("cloud-compare", ctx("dummy"), nextId(), { protocol: "moq" });
    assert.ok(moq.endpoints.every((endpoint) => endpoint.protocol === "moq"));
    assert.ok(
      moq.endpoints.every((endpoint) => endpoint.ingestEndpointId.endsWith("_moq_relay_d18")),
    );
    assert.equal(
      moq.endpoints.some(
        (endpoint) =>
          endpoint.ingestEndpointId.includes("moq_relay") && !endpoint.ingestEndpointId.endsWith("_d18"),
      ),
      false,
    );
  });

  it("keeps protocol comparison on e2e 4-way d18 (not leftover :4433)", () => {
    const plan = applyBenchmarkPreset("protocol-compare", ctx("dummy"), nextId());
    assert.equal(plan.testScope, TEST_SCOPE_E2E);
    const protocols = plan.endpoints.map((endpoint) => endpoint.protocol).sort();
    assert.deepEqual(protocols, ["moq", "rtmp", "srt", "webrtc"]);
    const moq = plan.endpoints.find((endpoint) => endpoint.protocol === "moq");
    assert.ok(moq?.ingestEndpointId.endsWith("_moq_relay_d18"), moq?.ingestEndpointId);
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has(moq?.ingestEndpointId ?? ""), false);
  });

  it("keeps contribution on upload-only so ingest is not glass (webcam or cloud VOD)", () => {
    const webcam = applyBenchmarkPreset("contribution-compare", ctx("webcam"), nextId());
    assert.equal(webcam.source, "webcam");
    assert.equal(webcam.testScope, TEST_SCOPE_UPLOAD);
    assert.equal(canOverlayTestScopes([TEST_SCOPE_E2E, webcam.testScope]), false);
    const vod = applyBenchmarkPreset("contribution-compare", ctx("dummy"), nextId(), { source: "dummy" });
    assert.equal(vod.source, "dummy");
    assert.equal(vod.testScope, TEST_SCOPE_UPLOAD);
    assert.equal(vod.encoder, "ffmpeg");
  });

  it("maps playa-file to cloud BBB on west :14433", () => {
    const plan = parseOperatorSearch("?operator=playa-file");
    assert.equal(plan.source, "bbb");
    assert.equal(plan.outputs[0]?.ingestEndpointId, "gcp_moq_relay_d18");
  });

  it("maps browser4 onto the MoQ vs WebRTC recipe", () => {
    const plan = parseOperatorSearch("?operator=browser4");
    assert.equal(plan.operator, "browser4");
    assert.equal(plan.source, "browser_moq");
    assert.equal(plan.encoder, "browser");
    assert.equal(operatorBenchmarkPreset(plan.operator), "webrtc-vs-moq");
    assert.equal(plan.outputs.length, 4);
  });
});

describe("Go Live and segmentation hops", () => {
  it("hides Go Live on WHEP / LOC / upload; shows it on CMAF / HLS / TS", () => {
    assert.equal(goLiveButtonVisible({ engine: "whep" }), false);
    assert.equal(goLiveButtonVisible({ engine: "moq", packaging: "loc" }), false);
    assert.equal(goLiveButtonVisible({ engine: "hls", testScope: "upload" }), false);
    assert.equal(goLiveButtonVisible({ engine: "moq", packaging: "cmaf" }), true);
    assert.equal(goLiveButtonVisible({ engine: "ll-hls" }), true);
    assert.equal(goLiveButtonVisible({ engine: "mpegts" }), true);
    assert.equal(goLiveButtonVisible({ engine: "dash" }), true);
  });

  it("does not give file or cloud playout the webcam 1s broker GOP", () => {
    assert.equal(isBrokeredWebcamMedia("dummy.mp4"), false);
    assert.equal(isBrokeredWebcamMedia("bbb.mp4"), false);
    assert.equal(isBrokeredWebcamMedia("/tmp/clip.mp4"), false);
    assert.equal(isBrokeredWebcamMedia("device:webcam"), false);
    assert.equal(isBrokeredWebcamMedia("udp://127.0.0.1:50123"), true);

    const file = segmentationMsForPublish("moq", 400, { mediaPath: "dummy.mp4" });
    const cloud = segmentationMsForPublish("moq", 400, { mediaPath: "bbb.mp4" });
    const broker = segmentationMsForPublish("moq", 400, { mediaPath: "udp://127.0.0.1:9" });
    assert.equal(file.notApplicable, false);
    assert.equal(cloud.ms, file.ms);
    assert.equal(file.ms, moqGroupDurationMs(400));
    assert.notEqual(file.ms, 1000);
    assert.equal(broker.ms, 1000);
    assert.equal(segmentationMsForPublish("srt", 2000, { mediaPath: "dummy.mp4" }).notApplicable, true);
    assert.equal(segmentationMsForPublish("webrtc", 400).notApplicable, true);
  });

  it("keeps file / cloud pipeline GOP notes off the webcam broker", () => {
    assert.equal(encoderSectionMoqGopNote("ffmpeg").includes("webcam"), false);
    assert.equal(encoderSectionMoqGopNote("ffmpeg-local").includes("broker"), true);
  });
});
