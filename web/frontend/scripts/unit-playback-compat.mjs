/**
 * Lightweight unit checks for player↔host compatibility rules
 * (mirrors web/frontend/src/playbackUrls.ts without a full Vitest setup).
 */
import assert from "node:assert/strict";

function ingestRole(id) {
  const value = String(id);
  if (value.endsWith("_moq_relay")) return "moq_relay";
  if (value.endsWith("_mediamtx")) return "mediamtx";
  if (value.endsWith("_zixi")) return "zixi";
  return null;
}
function isMediaMtxManaged(id) {
  return ingestRole(id) === "mediamtx";
}
function isZixiManagedIngest(id) {
  return ingestRole(id) === "zixi";
}

function isPlaybackModeCompatible(mode, protocol, ingestEndpointId = "") {
  if (mode === "auto") return false;
  if (protocol === "moq") return mode === "moq";
  if (mode === "moq") return false;
  if (protocol === "webrtc") return mode === "whep";
  const mediamtx = isMediaMtxManaged(ingestEndpointId);
  const zixi = isZixiManagedIngest(ingestEndpointId);
  if (mediamtx) {
    return mode === "ll-hls" || mode === "ll-dash" || mode === "hls" || mode === "whep";
  }
  if (zixi) {
    if (protocol === "srt" && mode === "hls") return false;
    return mode === "hls" || mode === "mpegts";
  }
  if (protocol === "srt" || protocol === "rtmp" || protocol === "hls" || protocol === "dash") {
    return mode === "hls" || mode === "mpegts" || mode === "whep";
  }
  return false;
}

function playbackModeBlockedReason(mode, protocol, ingestEndpointId = "") {
  if (mode === "hls" && protocol === "srt" && isZixiManagedIngest(ingestEndpointId)) {
    return "Zixi Fast HLS wedges on SRT ingest (playlist TARGETDURATION stalls). Use MPEG-TS.";
  }
  return undefined;
}

function playbackModesForSelection(protocol, ingestEndpointId = "") {
  const ids = ["hls", "ll-hls", "dash", "ll-dash", "whep", "moq", "mpegts"];
  return ids.filter(
    (id) =>
      isPlaybackModeCompatible(id, protocol, ingestEndpointId) ||
      Boolean(playbackModeBlockedReason(id, protocol, ingestEndpointId)),
  );
}

function playbackModeLabelForSelection(mode, protocol, ingestEndpointId = "") {
  const labels = {
    hls: "HLS (hls.js)",
    "ll-hls": "LL-HLS (hls.js)",
    mpegts: "MPEG-TS (mpegts.js)",
    moq: "MoQ Playback (Playa)",
  };
  const base = labels[mode] ?? mode;
  if (playbackModeBlockedReason(mode, protocol, ingestEndpointId)) {
    return `${base} — unavailable with Zixi SRT`;
  }
  if (mode === defaultPlaybackModeForProtocol(protocol, ingestEndpointId)) {
    return `${base} (recommended)`;
  }
  return base;
}

function defaultPlaybackModeForProtocol(protocol, ingestEndpointId = "") {
  if (protocol === "moq") return "moq";
  if (protocol === "webrtc") return "whep";
  if (protocol === "hls") return "mpegts";
  if (isMediaMtxManaged(ingestEndpointId)) return "ll-hls";
  if (isZixiManagedIngest(ingestEndpointId)) {
    return "mpegts";
  }
  if (protocol === "dash") return "hls";
  return "hls";
}

function resolvedPlaybackMode(mode, protocol, ingestEndpointId = "") {
  if (mode && isPlaybackModeCompatible(mode, protocol, ingestEndpointId)) {
    return mode;
  }
  const fallback = defaultPlaybackModeForProtocol(protocol, ingestEndpointId);
  if (isPlaybackModeCompatible(fallback, protocol, ingestEndpointId)) {
    return fallback;
  }
  return "hls";
}

// Concrete defaults used by the site (no Auto sentinel)
assert.equal(defaultPlaybackModeForProtocol("srt", "gcp_mediamtx"), "ll-hls");
assert.equal(defaultPlaybackModeForProtocol("srt", "gcp_east_mediamtx"), "ll-hls");
assert.equal(defaultPlaybackModeForProtocol("srt", "linode_mediamtx"), "ll-hls");
assert.equal(defaultPlaybackModeForProtocol("rtmp", "gcp_zixi"), "mpegts");
assert.equal(defaultPlaybackModeForProtocol("rtmp", "gcp_east_zixi"), "mpegts");
assert.equal(defaultPlaybackModeForProtocol("srt", "linode_zixi"), "mpegts");
assert.equal(defaultPlaybackModeForProtocol("srt", "gcp_zixi"), "mpegts");
assert.equal(defaultPlaybackModeForProtocol("moq", "gcp_moq_relay"), "moq");
assert.equal(defaultPlaybackModeForProtocol("webrtc", "gcp_mediamtx"), "whep");
assert.equal(defaultPlaybackModeForProtocol("srt", "custom"), "hls");

assert.equal(isMediaMtxManaged("linode_mediamtx"), true);
assert.equal(isMediaMtxManaged("gcp_east_mediamtx"), true);
assert.equal(isMediaMtxManaged("gcp_east_zixi"), false);
assert.equal(isZixiManagedIngest("gcp_east_zixi"), true);
assert.equal(isZixiManagedIngest("linode_zixi"), true);
assert.equal(isZixiManagedIngest("linode_mediamtx"), false);

assert.equal(
  playbackModeLabelForSelection("ll-hls", "srt", "gcp_mediamtx"),
  "LL-HLS (hls.js) (recommended)",
);
assert.equal(
  playbackModeLabelForSelection("hls", "rtmp", "gcp_zixi"),
  "HLS (hls.js)",
);
assert.equal(
  playbackModeLabelForSelection("mpegts", "rtmp", "gcp_zixi"),
  "MPEG-TS (mpegts.js) (recommended)",
);
assert.equal(
  playbackModeLabelForSelection("hls", "srt", "gcp_zixi"),
  "HLS (hls.js) — unavailable with Zixi SRT",
);

// Legacy Auto is not selectable
assert.equal(isPlaybackModeCompatible("auto", "rtmp", "gcp_zixi"), false);
assert.equal(isPlaybackModeCompatible("auto", "srt", "gcp_mediamtx"), false);

// Zixi must not offer MTX-only or broken embed modes
for (const ingest of ["gcp_zixi", "gcp_east_zixi", "linode_zixi"]) {
  for (const mode of ["ll-hls", "ll-dash", "whep", "dash", "zixi-embed", "webrtc", "moq"]) {
    assert.equal(
      isPlaybackModeCompatible(mode, "rtmp", ingest),
      false,
      `${ingest} should reject ${mode}`,
    );
  }
  assert.equal(isPlaybackModeCompatible("hls", "rtmp", ingest), true, ingest);
  assert.equal(isPlaybackModeCompatible("hls", "srt", ingest), false, ingest);
  assert.equal(isPlaybackModeCompatible("mpegts", "srt", ingest), true, ingest);
  assert.equal(resolvedPlaybackMode("hls", "srt", ingest), "mpegts", ingest);
  assert.ok(playbackModeBlockedReason("hls", "srt", ingest), ingest);
  assert.equal(playbackModeBlockedReason("hls", "rtmp", ingest), undefined, ingest);
  assert.deepEqual(playbackModesForSelection("srt", ingest), ["hls", "mpegts"]);
}

// MediaMTX matrix (every cloud, not just us-central1)
for (const ingest of ["gcp_mediamtx", "gcp_east_mediamtx", "linode_mediamtx"]) {
  for (const mode of ["ll-hls", "ll-dash", "hls", "whep"]) {
    assert.equal(isPlaybackModeCompatible(mode, "srt", ingest), true, `${ingest} ${mode}`);
  }
  assert.equal(isPlaybackModeCompatible("mpegts", "srt", ingest), false, ingest);
}

// MoQ locked to Playa
assert.equal(isPlaybackModeCompatible("moq", "moq", "gcp_moq_relay"), true);
assert.equal(isPlaybackModeCompatible("auto", "moq", "gcp_moq_relay"), false);
assert.equal(isPlaybackModeCompatible("hls", "moq", "gcp_moq_relay"), false);
assert.equal(isPlaybackModeCompatible("whep", "webrtc", "gcp_mediamtx"), true);
assert.equal(isPlaybackModeCompatible("ll-hls", "webrtc", "gcp_mediamtx"), false);

const INGEST_MATRIX = [
  ["srt", "gcp_zixi"],
  ["srt", "gcp_east_zixi"],
  ["srt", "linode_zixi"],
  ["srt", "gcp_mediamtx"],
  ["rtmp", "gcp_zixi"],
  ["moq", "gcp_moq_relay"],
  ["webrtc", "gcp_mediamtx"],
  ["moq", "linode_moq_relay"],
  ["srt", "custom"],
  ["dash", "custom"],
];
for (const [protocol, ingest] of INGEST_MATRIX) {
  const mode = defaultPlaybackModeForProtocol(protocol, ingest);
  assert.equal(
    isPlaybackModeCompatible(mode, protocol, ingest),
    true,
    `default ${mode} must be compatible for ${protocol}/${ingest}`,
  );
  assert.equal(resolvedPlaybackMode("ll-dash", protocol, ingest) === "ll-dash"
    ? isPlaybackModeCompatible("ll-dash", protocol, ingest)
    : true, true);
}

console.log("unit-playback-compat: PASS");
