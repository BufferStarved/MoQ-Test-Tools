/**
 * Browser WHIP must clone-safe encode (WebCodecs) and fail the job visibly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const whip = fs.readFileSync(path.join(root, "browserMoq/whipPublisher.ts"), "utf8");
assert.match(whip, /postPublisherError/);
assert.match(whip, /waitForIceConnected/);
assert.match(whip, /getVideoTracks\(\)/);
assert.match(whip, /includeAudio/);
assert.match(whip, /onFatalError/);
assert.match(whip, /WHIP ICE/);
assert.match(whip, /UDP 8189/);

const encoder = fs.readFileSync(path.join(root, "browserMoq/encoder.ts"), "utf8");
assert.match(encoder, /track\.clone/);
assert.match(encoder, /MediaStreamTrackProcessor/);
assert.match(encoder, /encodeTrack\.stop/);
assert.match(
  encoder,
  /track\.clone[\s\S]*?new MediaStreamTrackProcessor\(\{\s*track: encodeTrack\s*\}\)/,
);

const publisher = fs.readFileSync(path.join(root, "browserMoq/publisher.ts"), "utf8");
assert.match(publisher, /postPublisherReady\(leg\.jobId\)/);
assert.match(publisher, /firstIdr/);
assert.match(publisher, /postPublisherError/);
assert.match(publisher, /Promise\.allSettled/);
assert.doesNotMatch(
  publisher,
  /await connectMoq5WasmPublisher\([\s\S]*?await postPublisherReady\(leg\.jobId\);\s*return \{ leg, session \}/,
);

const loc = fs.readFileSync(path.join(root, "browserMoq/locCatalog.ts"), "utf8");
assert.match(loc, /includeAudio/);
assert.match(loc, /options\.videoCodec \|\| BROWSER_LOC_VIDEO_CODEC/);

console.log("unit-whip-publisher: PASS");
