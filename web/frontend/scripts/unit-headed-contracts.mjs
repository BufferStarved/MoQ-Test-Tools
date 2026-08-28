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

const app = src("App.tsx");
assert.match(app, /humanizeJobError\(leg\.job\.error,\s*\{\s*protocol:/);

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
