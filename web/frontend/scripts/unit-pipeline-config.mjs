/**
 * Pipeline config copy must match the actual encoder. Browser recipes used
 * to claim ffmpeg/libx264, and WHEP playback showed "None" as if it failed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pipelineConfig.ts"),
  "utf8",
);

assert.match(src, /PipelineEncodeKind = "ffmpeg" \| "ffmpeg-local" \| "obs" \| "browser"/);
assert.match(src, /value: "OBS Studio"/);
assert.doesNotMatch(src, /OBS Studio \+ OpenMOQ plugin/);
assert.match(src, /This browser — ffmpeg is not used/);
assert.match(src, /Native RTCPeerConnection encode/);
assert.match(src, /In-page WebCodecs → LOC objects/);
assert.match(src, /Direct WHEP/);
assert.match(src, /None — expected for WebRTC/);
assert.doesNotMatch(
  src,
  /subtitle: "Shared ffmpeg \/ libx264 settings for every stream in the recipe"/,
);
assert.match(src, /encoderSectionMoqGopNote/);
assert.match(src, /MoQ children re-encode at ~0\.25s when dest_count >= 2/);

console.log("unit-pipeline-config: PASS");
