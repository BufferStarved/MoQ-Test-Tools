/**
 * Unit checks for Zixi Fast HLS playlist helpers
 * (mirrors web/frontend/src/hlsPlaylist.ts + encodeProfiles.hlsSegmentSec).
 */
import assert from "node:assert/strict";

const HLS_TARGET_DURATION_CAP_SEC = 6;
const STALE_FRAG_FAIL_AFTER = 12;

function playlistExtinfMaxSec(body) {
  let max = 0;
  for (const match of body.matchAll(/#EXTINF:(\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max > 0 ? max : null;
}

function playlistTargetDurationSec(body) {
  const match = body.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
  const declared = match ? Number(match[1]) : NaN;
  const extinf = playlistExtinfMaxSec(body);
  if (extinf != null) {
    const extinfCeil = Math.max(1, Math.ceil(extinf));
    const declaredAbsurd =
      !Number.isFinite(declared) || declared > HLS_TARGET_DURATION_CAP_SEC * 2;
    if (declaredAbsurd || Math.abs(declared - extinf) >= 0.75) {
      return Math.min(HLS_TARGET_DURATION_CAP_SEC, extinfCeil);
    }
  }
  if (Number.isFinite(declared) && declared > 0) {
    return Math.max(1, Math.min(HLS_TARGET_DURATION_CAP_SEC, declared));
  }
  return 2;
}

function isStaleHlsFragmentLoop({ uniqueUrlCount, sameUrlLoads, videoAdvanced, threshold }) {
  if (videoAdvanced) return false;
  return uniqueUrlCount === 1 && sameUrlLoads >= (threshold ?? STALE_FRAG_FAIL_AFTER);
}

function hlsSegmentSec(ms) {
  return Math.max(2, Math.min(6, Math.floor(ms / 2000) || 2));
}

const ballooned = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:292",
  "#EXTINF:2.000,",
  "playback.ts?chunk=4",
].join("\n");
assert.equal(playlistTargetDurationSec(ballooned), 2);

const gopMismatch = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:3.000,",
  "playback.ts?chunk=1",
].join("\n");
assert.equal(playlistTargetDurationSec(gopMismatch), 3);

const healthy = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.000,",
  "playback.ts?chunk=8",
].join("\n");
assert.equal(playlistTargetDurationSec(healthy), 2);

assert.equal(
  isStaleHlsFragmentLoop({
    uniqueUrlCount: 1,
    sameUrlLoads: 20,
    videoAdvanced: true,
  }),
  false,
  "playing video must not be killed for 1-deep reloads",
);
assert.equal(
  isStaleHlsFragmentLoop({
    uniqueUrlCount: 1,
    sameUrlLoads: 12,
    videoAdvanced: false,
  }),
  true,
);
assert.equal(
  isStaleHlsFragmentLoop({
    uniqueUrlCount: 2,
    sameUrlLoads: 20,
    videoAdvanced: false,
  }),
  false,
);

assert.equal(hlsSegmentSec(5000), 2);
assert.equal(hlsSegmentSec(4000), 2);
assert.equal(hlsSegmentSec(6000), 3);

console.log("unit-hls-playlist: PASS");
