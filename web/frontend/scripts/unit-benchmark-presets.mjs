/**
 * Quick-start presets must emit coerceRecipe-legal endpoints and must not
 * invent ingest ids. Browser is an encoder (Webcam + Browser → browser_moq).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const presetSrc = fs.readFileSync(path.join(root, "src/benchmarkPresets.ts"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const operatorSrc = fs.readFileSync(path.join(root, "src/operatorRecipe.ts"), "utf8");
const sourceSrc = fs.readFileSync(path.join(root, "src/SourceSection.tsx"), "utf8");

assert.match(presetSrc, /protocol-compare/);
assert.match(presetSrc, /build-your-own/);
assert.match(presetSrc, /cloud-compare/);
assert.match(presetSrc, /contribution-compare/);
assert.match(presetSrc, /webrtc-vs-moq/);
assert.match(presetSrc, /label: "Ingest Comparison"/);
assert.match(presetSrc, /label: "Network Path & Cloud Comparison"/);
assert.match(presetSrc, /label: "MoQ vs WebRTC"/);
assert.match(presetSrc, /label: "Protocol Comparison"/);
assert.match(presetSrc, /label: "Build Your Own"/);
assert.match(presetSrc, /PRESET_COMPARISON_GROUP_LABEL = "Preset Comparisons"/);
assert.match(presetSrc, /You pick the source, destinations, and players\./);
assert.match(presetSrc, /Contribution and acquisition performance across clouds and protocols\./);
assert.match(presetSrc, /PLAYER_TEST_PLACEHOLDER/);
assert.match(presetSrc, /label: "Player Test"/);
assert.doesNotMatch(presetSrc, /Contribution Protocol Comparison for Streaming Workflows/);
assert.doesNotMatch(presetSrc, /WebRTC vs MOQ for realtime video\./);
assert.doesNotMatch(presetSrc, /label: "Watch all four protocols"/);
assert.doesNotMatch(presetSrc, /label: "Cloud compare"/);
assert.doesNotMatch(presetSrc, /label: "Capture to glass"/);
assert.doesNotMatch(presetSrc, /label: "Custom"/);
assert.doesNotMatch(presetSrc, /label: "Contribution ingest"/);
assert.doesNotMatch(presetSrc, /label: "Webcam Browsers"/);
assert.doesNotMatch(presetSrc, /label: "Cloud\/Edge Comparison"/);
assert.doesNotMatch(presetSrc, /label: "WebRTC vs MoQ"/);
assert.match(
  presetSrc,
  /id: "contribution-compare"[\s\S]*id: "cloud-compare"[\s\S]*id: "webrtc-vs-moq"[\s\S]*id: "protocol-compare"[\s\S]*id: "build-your-own"/,
);
assert.match(appSrc, /recipe-card-custom/);
assert.match(appSrc, /recipe-preset-group/);
assert.match(appSrc, /PRESET_COMPARISON_GROUP_LABEL/);
assert.match(appSrc, /PRESET_COMPARISON_DEFS/);
assert.match(appSrc, /BUILD_YOUR_OWN_DEF/);
assert.doesNotMatch(presetSrc, /label: "Build your own"/);
assert.doesNotMatch(presetSrc, /label: "Ingest comparison"/);
assert.match(presetSrc, /TEST_SCOPE_UPLOAD/);
assert.match(presetSrc, /defaultRecipeEndpoints/);
assert.match(presetSrc, /BROWSER4_OUTPUT_KEYS/);
assert.match(presetSrc, /coerceRecipe/);
assert.match(presetSrc, /recipeIssue/);
assert.match(presetSrc, /wizardStepVisible/);
assert.match(presetSrc, /recipeShowsEndpointPickers/);
assert.match(presetSrc, /recipeLocksProtocolMix/);
assert.match(presetSrc, /recipeLocksEndpoints/);
assert.match(presetSrc, /recipeShowsSharedProtocolPicker/);
assert.doesNotMatch(presetSrc, /showEndpointPickers:\s*true/);
assert.match(presetSrc, /lockProtocolMix:\s*true/);
assert.doesNotMatch(presetSrc, /lockEndpoints:\s*false/);
assert.match(presetSrc, /most stable path for each/);
assert.match(presetSrc, /Encode and ingest meters only/);
assert.match(presetSrc, /One protocol, compared across live network paths/);
assert.match(appSrc, /ideal live workflow/);
assert.match(appSrc, /handleBenchmarkPreset/);
assert.match(appSrc, /recipe-picker/);
assert.match(appSrc, /recipe-options/);
assert.match(appSrc, /recipe-custom-group/);
assert.match(appSrc, /PLAYER_TEST_PLACEHOLDER/);
assert.match(appSrc, /comingSoon/);
assert.match(appSrc, /What to Run/);
assert.match(appSrc, /wizardStepVisible/);
assert.match(appSrc, /recipeShowsEndpointPickers/);
assert.match(appSrc, /recipeShowsSharedProtocolPicker/);
assert.match(appSrc, /lockProtocol=\{lockOutputProtocol\}/);
assert.match(appSrc, /showOutputConfig && canAddOutput/);
assert.match(appSrc, /cloud-compare-protocol/);
assert.match(presetSrc, /Network path and player are chosen for you/);
assert.doesNotMatch(presetSrc, /aws_zixi/);
assert.doesNotMatch(appSrc, /handleBenchmarkPreset\([^)]+\);\s*void handleStart/);
assert.doesNotMatch(sourceSrc, /onMediaSourceChange\("browser_moq"\)/);
assert.match(
  sourceSrc,
  /VOD-to-Live Cloud Playout[\s\S]*Webcam/,
  "cloud VOD-to-live playout must be listed before webcam",
);
assert.match(operatorSrc, /source=webcam&encoder=browser/);
assert.match(operatorSrc, /parseOperatorEncoder/);

const CHROME = { safari: false, webTransport: true, rtcPeerConnection: true };

function ingestRole(id) {
  const value = String(id);
  if (value.includes("_moq_relay")) return "moq_relay";
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
  if (ingest === "gcp_moq_relay" || ingest === "gcp_east_moq_relay" || ingest === "linode_moq_relay") {
    return false;
  }
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

const protocolCompare = [
  { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
  { protocol: "rtmp", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
  { protocol: "webrtc", ingestEndpointId: "gcp_east_mediamtx", playbackMode: "whep" },
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay_d18", playbackMode: "moq" },
];
assert.equal(recipeIssue("dummy", "ffmpeg", protocolCompare), null, "protocol compare 4-way");
assert.equal(
  isLegalCombo("dummy", "moq", "gcp_moq_relay", "moq", "ffmpeg"),
  false,
  "protocol compare must not keep leftover :4433",
);

const cloudCompare = [
  { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay_d18", playbackMode: "moq" },
];
assert.equal(recipeIssue("dummy", "ffmpeg", cloudCompare), null, "cloud compare");
assert.equal(
  isLegalCombo("dummy", "moq", "gcp_moq_relay", "moq", "ffmpeg"),
  false,
  "cloud compare must not keep leftover :4433",
);

const contribution = [
  { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
  { protocol: "rtmp", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay_d18", playbackMode: "moq" },
];
assert.equal(recipeIssue("webcam", "ffmpeg", contribution), null, "contribution 3-way");
assert.equal(
  isLegalCombo("webcam", "webrtc", "gcp_mediamtx", "whep", "ffmpeg"),
  true,
  "webcam+ffmpeg webrtc still legal when WHIP exists",
);

const webrtcVsMoq = [
  { protocol: "moq", ingestEndpointId: "linode_moq_relay_d18", playbackMode: "moq" },
  { protocol: "webrtc", ingestEndpointId: "linode_mediamtx", playbackMode: "whep" },
  { protocol: "moq", ingestEndpointId: "gcp_east_moq_relay_d18", playbackMode: "moq" },
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

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(root, "src/benchmarkPresets.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, `benchmarkPresets.test.ts: ${unit.stderr || unit.stdout}`);

console.log("unit-benchmark-presets: PASS");
