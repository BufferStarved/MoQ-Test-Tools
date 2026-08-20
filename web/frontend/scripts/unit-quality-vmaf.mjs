/**
 * Quality scoring must match what the API actually runs — not a MoQ-only ingest gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

function wantsEncoderVmaf({ computeVmaf, encoderVmafAvailable, protocol, isLive }) {
  return computeVmaf && encoderVmafAvailable && !isLive && protocol !== "webrtc";
}
function wantsIngestVmaf({ computeVmaf, vmafAvailable, isLive, isBrowserSource }) {
  return computeVmaf && vmafAvailable && (!isLive || isBrowserSource);
}

assert.equal(
  wantsIngestVmaf({ computeVmaf: true, vmafAvailable: true, isLive: false, isBrowserSource: false }),
  true,
  "Zixi SRT/RTMP file runs must request ingest VMAF",
);
assert.equal(
  wantsIngestVmaf({
    computeVmaf: true,
    vmafAvailable: true,
    isLive: false,
    isBrowserSource: false,
    // protocol is intentionally unused — ingest is destination-capability, not MoQ-only
  }),
  true,
);
assert.equal(
  wantsEncoderVmaf({
    computeVmaf: true,
    encoderVmafAvailable: true,
    protocol: "srt",
    isLive: false,
  }),
  true,
);
assert.equal(
  wantsEncoderVmaf({
    computeVmaf: true,
    encoderVmafAvailable: true,
    protocol: "webrtc",
    isLive: false,
  }),
  false,
);
assert.equal(
  wantsIngestVmaf({
    computeVmaf: true,
    vmafAvailable: false,
    isLive: false,
    isBrowserSource: false,
  }),
  false,
  "MediaMTX has no ingest recorder",
);
assert.equal(
  wantsEncoderVmaf({
    computeVmaf: true,
    encoderVmafAvailable: true,
    protocol: "srt",
    isLive: true,
  }),
  false,
);

const whip = fs.readFileSync(
  new URL("../src/browserMoq/whipPublisher.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(whip, /vmaf_score:\s*qpQuality/, "QP must not be posted as VMAF");

const jobManager = fs.readFileSync(
  new URL("../../../web/api/job_manager.py", import.meta.url),
  "utf8",
);
assert.doesNotMatch(jobManager, /webrtc_qp/, "browser jobs must not promote QP to encoder VMAF");

console.log("unit-quality-vmaf: PASS");
