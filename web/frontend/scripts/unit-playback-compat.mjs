/**
 * Lightweight unit checks for player↔host compatibility rules
 * (mirrors web/frontend/src/playbackUrls.ts without a full Vitest setup).
 */
import assert from "node:assert/strict";

function isMediaMtxManaged(id) {
  return id === "gcp_mediamtx" || String(id).startsWith("gcp_mediamtx");
}
function isZixiManagedIngest(id) {
  return (
    id === "gcp_zixi" ||
    String(id).startsWith("gcp_zixi") ||
    String(id).startsWith("aws_zixi") ||
    String(id).startsWith("linode_zixi")
  );
}

function isPlaybackModeCompatible(mode, protocol, ingestEndpointId = "") {
  if (protocol === "moq") return mode === "moq";
  if (mode === "auto") return true;
  if (mode === "moq") return false;
  const mediamtx = isMediaMtxManaged(ingestEndpointId);
  const zixi = isZixiManagedIngest(ingestEndpointId);
  if (mediamtx) {
    return mode === "ll-hls" || mode === "ll-dash" || mode === "hls" || mode === "whep";
  }
  if (zixi) return mode === "hls" || mode === "mpegts";
  if (protocol === "srt" || protocol === "rtmp" || protocol === "hls" || protocol === "dash") {
    return mode === "hls" || mode === "mpegts" || mode === "whep";
  }
  if (protocol === "webrtc") return mode === "whep";
  return false;
}

function defaultPlaybackModeForProtocol(protocol, ingestEndpointId = "") {
  if (protocol === "moq") return "moq";
  if (isMediaMtxManaged(ingestEndpointId)) return "ll-hls";
  return "auto";
}

// Auto defaults used by the site
assert.equal(defaultPlaybackModeForProtocol("srt", "gcp_mediamtx"), "ll-hls");
assert.equal(defaultPlaybackModeForProtocol("rtmp", "gcp_zixi"), "auto");
assert.equal(defaultPlaybackModeForProtocol("moq", "gcp_moq_relay"), "moq");

// Zixi must not offer MTX-only or broken embed modes
for (const mode of ["ll-hls", "ll-dash", "whep", "dash", "zixi-embed", "webrtc", "moq"]) {
  assert.equal(
    isPlaybackModeCompatible(mode, "rtmp", "gcp_zixi"),
    false,
    `zixi should reject ${mode}`,
  );
}
assert.equal(isPlaybackModeCompatible("hls", "rtmp", "gcp_zixi"), true);
assert.equal(isPlaybackModeCompatible("mpegts", "srt", "gcp_zixi"), true);

// MediaMTX matrix
for (const mode of ["ll-hls", "ll-dash", "hls", "whep", "auto"]) {
  assert.equal(isPlaybackModeCompatible(mode, "srt", "gcp_mediamtx"), true, mode);
}
assert.equal(isPlaybackModeCompatible("mpegts", "srt", "gcp_mediamtx"), false);

// MoQ locked to Playa
assert.equal(isPlaybackModeCompatible("moq", "moq", "gcp_moq_relay"), true);
assert.equal(isPlaybackModeCompatible("auto", "moq", "gcp_moq_relay"), false);
assert.equal(isPlaybackModeCompatible("hls", "moq", "gcp_moq_relay"), false);

console.log("unit-playback-compat: PASS");
