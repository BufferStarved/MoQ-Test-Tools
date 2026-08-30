/**
 * Wiring the isolated unit tests cannot see. Comparison 30 had
 * noMediaFailMessage(subscribeRejected: true) passing while the player
 * never set that flag from a playa 0x10 warn.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => fs.readFileSync(path.join(root, "src", rel), "utf8");
const py = (rel) =>
  fs.readFileSync(path.resolve(root, "../..", rel), "utf8");
const gate = fs.readFileSync(
  path.resolve(root, "../..", "scripts/run-regression.sh"),
  "utf8",
);

const moqPlayer = src("players/MoqPlayer.tsx");
assert.match(moqPlayer, /isSubscribeRejectedLog/);
assert.match(moqPlayer, /subscribe_0x10_keepalive \(playa warn/);
assert.match(moqPlayer, /loc_0x10_retry/);
assert.match(moqPlayer, /no knownTracks race/);
assert.doesNotMatch(moqPlayer, /knownTracks:\s*browserLocKnownTracks/);

const locCatalog = src("browserMoq/locCatalog.ts");
assert.match(locCatalog, /locCatalogFetchEndLocation/);
assert.match(locCatalog, /LARGEST_OBJECT/);
assert.match(src("browserMoq/moq5Service.ts"), /serveCatalogFetch/);
assert.match(src("browserMoq/moq5Service.ts"), /serveVideoFetch/);
assert.match(src("browserMoq/moq5Service.ts"), /sendLastIdrToSubscriber/);
assert.match(src("browserMoq/moq5Service.ts"), /locIdrReplayGroup\(lastIdr\.groupId\)/);
assert.match(
  src("browserMoq/moq5Service.ts"),
  /locSubscriberLargestLocation\(videoGroupId, subscriber\.objectId\)/,
);
assert.match(src("players/MoqPlayer.tsx"), /decoderConfiguredMs/);
assert.match(src("browserMoq/locCatalog.ts"), /locVideoFetchShouldServe/);
assert.match(src("browserMoq/locCatalog.ts"), /locSubscriberLargestLocation/);
assert.match(src("browserMoq/locCatalog.ts"), /locIdrReplayGroup/);
assert.match(src("players/MoqPlayer.tsx"), /post-catalog/);
assert.match(src("comparisonReplay.test.ts"), /ca7bbb62/);
assert.match(src("comparisonReplay.test.ts"), /8aeaa2e4/);
assert.match(src("comparisonReplay.test.ts"), /9e0a507e/);
assert.match(src("comparisonReplay.test.ts"), /b2969493/);
assert.match(src("comparisonReplay.test.ts"), /1f61f56d/);
assert.match(src("players/MoqPlayer.tsx"), /startLocCanvasRenderer/);
assert.match(src("moqLocPlayback.ts"), /startLocCanvasRenderer/);
assert.match(
  fs.readFileSync(path.join(root, "vendor/moq-playa/packages/playa/src/player.ts"), "utf8"),
  /already playing/,
);
assert.match(src("browserMoq/h264AnnexB.ts"), /normalizeLocVideoAccessUnit/);
assert.match(src("browserMoq/h264AnnexB.ts"), /nalsToAvcc/);
assert.match(src("browserMoq/encoder.ts"), /normalizeLocVideoAccessUnit/);
assert.match(
  src("browserMoq/encoder.ts"),
  /avc:\s*\{\s*format:\s*avcFormat\s*\}/,
);
assert.doesNotMatch(
  fs.readFileSync(
    path.join(root, "vendor/moq-playa/packages/player/src/player-pipeline.ts"),
    "utf8",
  ),
  /new Uint8Array\(0\);\s*\n\s*pipelines\.videoPipeline\.configure/,
);

const replay = src("comparisonReplay.ts");
assert.match(replay, /moqx_publish_namespace_success >= 1/);
assert.match(replay, /catalog watchdog expired/);
assert.match(replay, /classifyMoqEndVerdict/);
assert.match(replay, /inferCatalogReady/);
assert.match(replay, /comparisonLegTone/);
assert.match(src("comparisonReplay.test.ts"), /COMPARISON_31/);
assert.match(src("comparisonReplay.test.ts"), /visibleLeg\(/);
assert.match(
  src("comparisonReplay.test.ts"),
  /Encode-only success is a player failure/,
);

const app = src("App.tsx");
assert.match(app, /humanizeJobError\(leg\.job\.error,\s*\{\s*protocol:/);
assert.match(app, /comparisonLegTone/);
assert.match(app, /outputStatusLabel/);
assert.match(src("TopSummaryStrip.tsx"), /comparisonLegTone/);
assert.match(app, /one shared encode, copy remux per dest/);
assert.match(py("src/cloud_encode_slots.py"), /DEFAULT_MAX_CONCURRENT_CLOUD_ENCODES = 4/);
assert.match(py("src/comparison_encode_hub.py"), /SHARED_ENCODE_QUERY/);
assert.match(py("web/api/job_manager.py"), /attach_shared_encode/);
assert.match(py("web/api/job_manager.py"), /not shared_url/);

const cmaf = src("moqCmafPlayback.ts");
assert.match(cmaf, /MOQ_NO_SUCH_NAMESPACE = 0x10/);

const mpeg = src("players/MpegTsPlayer.tsx");
assert.match(mpeg, /classifyMpegTsEndVerdict/);
assert.doesNotMatch(mpeg, /setStatus\("Encode finished"\)/);

const dash = src("players/DashPlayer.tsx");
assert.match(dash, /DASH never painted/);
assert.match(dash, /stallAgainstEncodeMessage/);
assert.match(dash, /encodeDurationSec/);

const hls = src("players/HlsPlayer.tsx");
assert.match(hls, /classifyHlsEndVerdict/);
assert.match(hls, /encodeDurationSec/);
assert.doesNotMatch(hls, /setStatus\("Encode finished"\)/);

const streamPlayer = src("StreamPlayer.tsx");
assert.match(streamPlayer, /engine === "hls"/);
assert.match(streamPlayer, /encodeDurationSec=\{encodeDurationSec\}/);

const apiTs = src("api.ts");
assert.doesNotMatch(apiTs, /34\.28\.164\.90:8000/);

const moqApi = py("web/api/main.py");
assert.match(moqApi, /leftover :8000 is not a default/);

const upload = py("src/upload_service.py");
assert.match(upload, /def _ffmpeg_failure_message\(/);
assert.match(upload, /protocol: str = ""/);
assert.match(upload, /proto == "moq" and \(/);
assert.match(upload, /if moqx_poller.observing:/);

const preview = py("src/moq_preview.py");
assert.match(preview, /return bool\(publish_confirmed\)/);
assert.match(preview, /catalog_published/);
assert.match(preview, /bench-aef84d9a/);
assert.doesNotMatch(preview, /return past_deadline/);

assert.match(app, /Copy the helper command under Encode/);
assert.match(app, /encoder === "ffmpeg" &&\s*mediaSource === "webcam"/);
assert.doesNotMatch(src("SourceSection.tsx"), /LocalPublisherSetup/);
assert.match(src("recipeSupport.ts"), /ffmpeg always offers WHIP/);

assert.match(gate, /experimental-strip-types --test/);
assert.match(gate, /tests.test_moq_preview/);

console.log("unit-headed-contracts: PASS");
