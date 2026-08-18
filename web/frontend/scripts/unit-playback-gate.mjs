/**
 * MoQ must go live as soon as the encode job is running. Waiting for
 * preview_ready misses the one-shot catalog on a cache-less moqx.
 */
import assert from "node:assert/strict";

function playbackGateForJob(job, benchmarkStarting) {
  if (benchmarkStarting && !job) return "waiting";
  if (!job) return "idle";
  if (job.status === "pending") return "waiting";
  if (job.status === "running") {
    if (job.preview_ready === false) {
      const protocol = (job.protocol || "").toLowerCase();
      if (protocol !== "moq" && protocol !== "webrtc") {
        return "waiting";
      }
    }
    return "live";
  }
  return "ended";
}

assert.equal(
  playbackGateForJob({ status: "running", protocol: "moq", preview_ready: false }, false),
  "live",
);
assert.equal(
  playbackGateForJob({ status: "running", protocol: "srt", preview_ready: false }, false),
  "waiting",
);
assert.equal(
  playbackGateForJob({ status: "running", protocol: "srt", preview_ready: true }, false),
  "live",
);
assert.equal(
  playbackGateForJob({ status: "running", protocol: "rtmp", preview_ready: false }, false),
  "waiting",
);
assert.equal(
  playbackGateForJob({ status: "running", protocol: "webrtc", preview_ready: false }, false),
  "live",
);
assert.equal(playbackGateForJob({ status: "pending", protocol: "moq" }, false), "waiting");
assert.equal(playbackGateForJob({ status: "completed", protocol: "moq" }, false), "ended");

console.log("unit-playback-gate: PASS");
