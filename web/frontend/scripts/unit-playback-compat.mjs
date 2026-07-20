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
  if (mode === "auto") return false;
  if (protocol === "moq") return mode === "moq";
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
  if (protocol === "webrtc") return "whep";
  if (protocol === "hls") return "mpegts";
  if (isMediaMtxManaged(ingestEndpointId)) return "ll-hls";
  if (isZixiManagedIngest(ingestEndpointId)) return "hls";
  if (protocol === "dash") return "dash";
  return "hls";
}

function playbackModeLabelForSelection(mode, protocol, ingestEndpointId = "") {
  const labels = {
    hls: "HLS Playback (Live)",
    "ll-hls": "LL-HLS (MediaMTX)",
    moq: "MoQ Playback (Playa)",
  };
  const base = labels[mode] ?? mode;
  if (mode === defaultPlaybackModeForProtocol(protocol, ingestEndpointId)) {
    return `${base} (recommended)`;
  }
  return base;
}

// Concrete defaults used by the site (no Auto sentinel)
assert.equal(defaultPlaybackModeForProtocol("srt", "gcp_mediamtx"), "ll-hls");
assert.equal(defaultPlaybackModeForProtocol("rtmp", "gcp_zixi"), "hls");
assert.equal(defaultPlaybackModeForProtocol("moq", "gcp_moq_relay"), "moq");
assert.equal(defaultPlaybackModeForProtocol("srt", "custom"), "hls");

assert.equal(
  playbackModeLabelForSelection("ll-hls", "srt", "gcp_mediamtx"),
  "LL-HLS (MediaMTX) (recommended)",
);
assert.equal(
  playbackModeLabelForSelection("hls", "rtmp", "gcp_zixi"),
  "HLS Playback (Live) (recommended)",
);
assert.equal(playbackModeLabelForSelection("mpegts", "rtmp", "gcp_zixi"), "mpegts");

// Legacy Auto is not selectable
assert.equal(isPlaybackModeCompatible("auto", "rtmp", "gcp_zixi"), false);
assert.equal(isPlaybackModeCompatible("auto", "srt", "gcp_mediamtx"), false);

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
for (const mode of ["ll-hls", "ll-dash", "hls", "whep"]) {
  assert.equal(isPlaybackModeCompatible(mode, "srt", "gcp_mediamtx"), true, mode);
}
assert.equal(isPlaybackModeCompatible("mpegts", "srt", "gcp_mediamtx"), false);

// MoQ locked to Playa
assert.equal(isPlaybackModeCompatible("moq", "moq", "gcp_moq_relay"), true);
assert.equal(isPlaybackModeCompatible("auto", "moq", "gcp_moq_relay"), false);
assert.equal(isPlaybackModeCompatible("hls", "moq", "gcp_moq_relay"), false);

console.log("unit-playback-compat: PASS");
