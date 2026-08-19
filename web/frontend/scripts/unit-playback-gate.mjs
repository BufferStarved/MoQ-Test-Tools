/**
 * ffmpeg MoQ must go live as soon as the encode job is running. Waiting for
 * preview_ready misses the one-shot catalog on a cache-less moqx.
 * Browser LOC/WHIP must wait — empty LargestObject never attaches later groups.
 */
import assert from "node:assert/strict";

function playbackGateForJob(job, benchmarkStarting) {
  if (benchmarkStarting && !job) return "waiting";
  if (!job) return "idle";
  if (job.status === "pending" || job.status === "queued") return "waiting";
  if (job.status === "running") {
    if (job.preview_ready === false) {
      const protocol = (job.protocol || "").toLowerCase();
      const browser = (job.publisher_host || "").toLowerCase() === "browser";
      if (browser && (protocol === "moq" || protocol === "webrtc")) {
        return "waiting";
      }
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
  playbackGateForJob(
    { status: "running", protocol: "moq", publisher_host: "browser", preview_ready: false },
    false,
  ),
  "waiting",
);
assert.equal(
  playbackGateForJob(
    { status: "running", protocol: "webrtc", publisher_host: "browser", preview_ready: false },
    false,
  ),
  "waiting",
);
assert.equal(
  playbackGateForJob(
    { status: "running", protocol: "moq", publisher_host: "browser", preview_ready: true },
    false,
  ),
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
assert.equal(playbackGateForJob({ status: "queued", protocol: "srt" }, false), "waiting");
assert.equal(playbackGateForJob({ status: "completed", protocol: "moq" }, false), "ended");

function waitingPlayerStatus({ engine, jobStatus, waitingForEncodeSlot, encodeQueueAhead } = {}) {
  const queued =
    waitingForEncodeSlot || jobStatus === "queued" || jobStatus === "pending";
  if (queued) {
    const ahead = encodeQueueAhead ?? 0;
    if (jobStatus === "pending") return "Waiting for encode to start...";
    if (ahead > 0) return `Waiting for encode slot (${ahead} ahead)...`;
    return "Waiting for encode slot...";
  }
  if (engine === "hls") return "Waiting for readable HLS segments...";
  if (engine === "moq") return "Waiting for MoQ publish...";
  return "Waiting for encode...";
}

assert.match(
  waitingPlayerStatus({
    engine: "hls",
    jobStatus: "queued",
    waitingForEncodeSlot: true,
    encodeQueueAhead: 1,
  }),
  /encode slot \(1 ahead\)/,
);
assert.doesNotMatch(
  waitingPlayerStatus({
    engine: "hls",
    jobStatus: "queued",
    waitingForEncodeSlot: true,
    encodeQueueAhead: 1,
  }),
  /readable HLS/,
);
assert.match(
  waitingPlayerStatus({ engine: "hls", jobStatus: "running" }),
  /readable HLS/,
);

console.log("unit-playback-gate: PASS");
