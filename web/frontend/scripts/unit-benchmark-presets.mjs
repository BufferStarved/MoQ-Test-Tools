/**
 * Quick-start presets must emit coerceRecipe-legal endpoints and must not
 * invent ingest ids. Browser is an encoder (Webcam + Browser → browser_moq).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const presetSrc = fs.readFileSync(path.join(root, "src/benchmarkPresets.ts"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const operatorSrc = fs.readFileSync(path.join(root, "src/operatorRecipe.ts"), "utf8");
const sourceSrc = fs.readFileSync(path.join(root, "src/SourceSection.tsx"), "utf8");

assert.match(presetSrc, /cloud-compare/);
assert.match(presetSrc, /contribution-compare/);
assert.match(presetSrc, /webrtc-vs-moq/);
assert.match(presetSrc, /defaultRecipeEndpoints/);
assert.match(presetSrc, /BROWSER4_OUTPUT_KEYS/);
assert.match(presetSrc, /coerceRecipe/);
assert.match(presetSrc, /recipeIssue/);
assert.match(appSrc, /handleBenchmarkPreset/);
assert.match(appSrc, /BENCHMARK_PRESET_DEFS/);
assert.doesNotMatch(appSrc, /handleBenchmarkPreset\([^)]+\);\s*void handleStart/);
assert.doesNotMatch(sourceSrc, /onMediaSourceChange\("browser_moq"\)/);
assert.match(operatorSrc, /source=webcam&encoder=browser/);
assert.match(operatorSrc, /parseOperatorEncoder/);

const CHROME = { safari: false, webTransport: true, rtcPeerConnection: true };

function ingestRole(id) {
  const value = String(id);
  if (value.endsWith("_moq_relay")) return "moq_relay";
  if (value.endsWith("_mediamtx")) return "mediamtx";
  if (value.endsWith("_zixi")) return "zixi";
  return null;
}

function collisionKey(ingest, protocol) {
  if (protocol === "moq" || ingest === "custom") return null;
  if (String(ingest).endsWith("_mediamtx")) return ingest;
  if (String(ingest).endsWith("_zixi")) return `${ingest}:${protocol === "srt" ? "srt" : "benchmark"}`;
  return `${ingest}:${protocol}`;
}

function isLegalCombo(source, protocol, ingest, player, encoder = "ffmpeg") {
  const effective = source === "browser_moq" ? "browser" : source === "webcam" ? encoder : "ffmpeg";
  const sourceProtocols =
    effective === "browser" ? ["moq", "webrtc"] : ["srt", "rtmp", "webrtc", "moq"];
  if (!sourceProtocols.includes(protocol)) return false;
  if (protocol === "moq" && !(CHROME.webTransport && !CHROME.safari)) return false;
  if (protocol === "webrtc" && !CHROME.rtcPeerConnection) return false;
  if (protocol === "webrtc" && effective === "obs") return false;
  if (ingest === "custom" && effective === "browser") return false;
  const role = ingestRole(ingest);
  if (protocol === "moq" && role !== "moq_relay") return false;
  if (protocol === "webrtc" && role !== "mediamtx") return false;
  if ((protocol === "srt" || protocol === "rtmp") && role !== "zixi" && role !== "mediamtx") {
    return false;
  }
  if (protocol === "moq" && player !== "moq") return false;
  if (protocol === "webrtc" && player !== "whep" && player !== "ll-hls" && player !== "hls") {
    return false;
  }
  return true;
}

function recipeIssue(source, encoder, endpoints) {
  const used = new Set();
  if (encoder === "obs" && !endpoints.some((item) => item.protocol === "moq")) {
    return "OBS needs MoQ";
  }
  for (const endpoint of endpoints) {
    if (!isLegalCombo(source, endpoint.protocol, endpoint.ingestEndpointId, endpoint.playbackMode, encoder)) {
      return "illegal combo";
    }
    const key = collisionKey(endpoint.ingestEndpointId, endpoint.protocol);
    if (key) {
      if (used.has(key)) return "collision";
      used.add(key);
    }
  }
  return null;
}

const cloudCompare = [
  { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay", playbackMode: "moq" },
];
assert.equal(recipeIssue("dummy", "ffmpeg", cloudCompare), null, "cloud compare");

const contribution = [
  { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
  { protocol: "rtmp", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay", playbackMode: "moq" },
];
assert.equal(recipeIssue("webcam", "ffmpeg", contribution), null, "contribution 3-way");
assert.equal(
  isLegalCombo("webcam", "webrtc", "gcp_mediamtx", "whep", "ffmpeg"),
  true,
  "webcam+ffmpeg webrtc still legal when WHIP exists",
);

const webrtcVsMoq = [
  { protocol: "moq", ingestEndpointId: "linode_moq_relay", playbackMode: "moq" },
  { protocol: "webrtc", ingestEndpointId: "linode_mediamtx", playbackMode: "whep" },
  { protocol: "moq", ingestEndpointId: "gcp_east_moq_relay", playbackMode: "moq" },
  { protocol: "webrtc", ingestEndpointId: "gcp_east_mediamtx", playbackMode: "whep" },
];
assert.equal(recipeIssue("browser_moq", "browser", webrtcVsMoq), null, "browser4 alias");
assert.equal(recipeIssue("webcam", "browser", webrtcVsMoq), null, "webcam+browser encoder");
assert.equal(
  isLegalCombo("webcam", "srt", "gcp_mediamtx", "ll-hls", "browser"),
  false,
  "browser encoder forbids srt",
);
assert.equal(
  isLegalCombo("webcam", "webrtc", "linode_mediamtx", "whep", "obs"),
  false,
  "obs forbids webrtc",
);

assert.match(appSrc, /handleStart\(\)/);
assert.equal((appSrc.match(/createUpload\(/g) || []).length, 1, "single job-create path");

console.log("unit-benchmark-presets: PASS");
