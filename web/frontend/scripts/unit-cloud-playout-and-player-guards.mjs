/**
 * Cloud playout must send a 60s clip. BBB on disk is ~10 min; omitting
 * duration_sec made ffmpeg play the whole file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const source = fs.readFileSync(path.join(root, "src/SourceSection.tsx"), "utf8");
const whep = fs.readFileSync(path.join(root, "src/players/WhepPlayer.tsx"), "utf8");
const moq = fs.readFileSync(path.join(root, "src/players/MoqPlayer.tsx"), "utf8");
const moqCmaf = fs.readFileSync(path.join(root, "src/moqCmafPlayback.ts"), "utf8");
const streamPlayer = fs.readFileSync(path.join(root, "src/StreamPlayer.tsx"), "utf8");

assert.match(source, /export const CLOUD_PLAYOUT_DURATION_SEC = 60/);
assert.match(app, /CLOUD_PLAYOUT_DURATION_SEC/);
assert.match(app, /mediaSource === "dummy" \|\| mediaSource === "bbb"/);
assert.match(app, /benchmark-start-row/);
assert.doesNotMatch(whep, /proxiedWebrtcSignalingUrl is not defined/);
assert.match(whep, /startWhepSession/);
assert.match(whep, /waitForWhepMedia/);
assert.doesNotMatch(whep, /@eyevinn\/webrtc-player/);
assert.match(moqCmaf, /Playback ended \(reconnected/);
assert.match(moq, /graceful_eos RESET_STREAM/);
assert.match(whep, /isGracefulWhepDisconnect/);
assert.match(whep, /unwrapFastApiDetail/);
assert.doesNotMatch(whep, /video\.muted = false/);
assert.match(whep, /video\.muted = true/);
assert.match(streamPlayer, /WhepPlayer[\s\S]*jobStatus=\{jobStatus\}/);
assert.match(fs.readFileSync(path.join(root, "src/players/MpegTsPlayer.tsx"), "utf8"), /graceful_eos/);
assert.match(moq, /playhead_frozen_hold/);
assert.match(moq, /isGracefulMoqEncodeOver/);
assert.match(moq, /encode_over_suppressed_fail/);
assert.match(moq, /classifyCmafPlayheadStall/);
assert.match(moq, /cmafSubscribeOptions/);
assert.match(moq, /moqRenderSink/);
assert.doesNotMatch(moq, /playhead_frozen_\$\{video\.currentTime\.toFixed\(2\)\}s_buffered/);
assert.match(streamPlayer, /player-idle-placeholder/);
assert.doesNotMatch(streamPlayer, /Preview starts with the encode/);
assert.match(app, /test-scope/);
assert.match(app, /playback-policy/);
assert.match(app, /ingest-monitor/);
assert.match(app, /isUploadOnlyScope\(testScope\)/);
assert.doesNotMatch(whep, /GoLiveButton/);
assert.match(moq, /goLiveButtonVisible/);

console.log("unit-cloud-playout-and-player-guards: PASS");
