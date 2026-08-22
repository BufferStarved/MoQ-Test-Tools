/**
 * OBS is a last-mile encoder option, not a source and not a ffmpeg replacement.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const sourceSrc = fs.readFileSync(path.join(root, "src/SourceSection.tsx"), "utf8");
const recipeSrc = fs.readFileSync(path.join(root, "src/recipeSupport.ts"), "utf8");
const operatorSrc = fs.readFileSync(path.join(root, "src/operatorRecipe.ts"), "utf8");

assert.match(sourceSrc, /type EncoderId = "ffmpeg" \| "obs" \| "browser"/);
assert.match(sourceSrc, /encoderModeExplainer/);
assert.doesNotMatch(sourceSrc, /OBS Virtual Camera/);
assert.doesNotMatch(sourceSrc, /onMediaSourceChange\("obs/);
assert.doesNotMatch(sourceSrc, /onMediaSourceChange\("browser_moq"\)/);
assert.doesNotMatch(sourceSrc, /onEncoderChange/);
assert.match(sourceSrc, /encoder !== "obs"/);

assert.match(appSrc, /encode-encoder-options/);
assert.match(appSrc, /mediaSource === "webcam"/);
assert.match(appSrc, /handleEncoderChange/);
assert.match(appSrc, /handleEncoderChange\("browser"\)/);
assert.match(appSrc, /operatorPlan\.encoder/);
assert.match(appSrc, /ffmpeg stays the default/);
assert.match(appSrc, /IconMonitor size=\{15\} \/> OBS/);
assert.doesNotMatch(appSrc, /OBS \+ OpenMOQ/);
assert.match(appSrc, /const MIN_ENDPOINTS = 1/);
assert.match(appSrc, /local_publisher_obs\?\.websocket/);
assert.doesNotMatch(appSrc, /local_publisher_obs\?\.plugin\)\)/);
assert.match(appSrc, /OBS WebSocket not connected on ws:\/\/127\.0\.0\.1:4455/);
assert.match(appSrc, /obsStartAllowed/);
assert.match(appSrc, /comparisonJobIdsRef/);
assert.match(appSrc, /stopRequestedRef/);
assert.match(appSrc, /Comparison stopped/);
assert.match(appSrc, /obsWebsocketHint/);
assert.match(appSrc, /startHint/);
assert.match(appSrc, /Enable Tools → WebSocket Server/);
assert.match(appSrc, /startHint && !loading/);
assert.doesNotMatch(appSrc, /setMediaLabel\("OBS scene"\)/);

assert.match(recipeSrc, /recipeEncoderForSource/);
assert.match(recipeSrc, /recipeRequiresMoq/);
assert.match(recipeSrc, /effective === "obs"/);
assert.match(recipeSrc, /needs a MoQ output/);
assert.match(recipeSrc, /OBS OpenMOQ plugin is draft-16 only/);
assert.match(recipeSrc, /obsMoqSupported/);
assert.match(sourceSrc, /plugin is draft-16 only/);
assert.match(appSrc, /obsEncoderSupported/);
assert.match(appSrc, /Unavailable · plugin is draft-16 only/);

assert.match(operatorSrc, /source=webcam&encoder=obs/);
assert.match(operatorSrc, /source=webcam&encoder=ffmpeg/);
assert.match(operatorSrc, /parseOperatorEncoder/);

console.log("unit-obs: PASS");
