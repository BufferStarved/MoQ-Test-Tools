/**
 * A failed encode/capture must stay on screen. Catalog-miss is the wrong
 * diagnosis when ffmpeg 251 / avfoundation already killed the job.
 * Mirrors web/frontend/src/moqCmafPlayback.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/moqCmafPlayback.ts"),
  "utf8",
);
assert.match(src, /playerErrorForFailedJob/);
assert.match(src, /humanizeJobError/);
assert.match(src, /isCaptureOrPublishError/);
assert.match(src, /jobError/);
assert.match(src, /catalog never loaded/i);

function isCaptureOrPublishError(error) {
  if (!error) return false;
  const text = error.toLowerCase();
  return (
    text.includes("ffmpeg exited") ||
    text.includes("shared webcam capture") ||
    text.includes("avfoundation") ||
    text.includes("selected framerate") ||
    text.includes("code 251") ||
    text.includes("input/output error") ||
    text.includes("conversion failed") ||
    text.includes("opening input") ||
    text.includes("never announced namespace") ||
    text.includes("catalog is not live")
  );
}

function humanizeJobError(error) {
  const raw = (error || "").trim();
  if (!raw) return null;
  if (!isCaptureOrPublishError(raw)) return raw;
  if (/framerate|avfoundation|shared webcam/i.test(raw)) {
    return "The camera on this laptop could not start, so nothing was published. This is not a player or catalog problem.";
  }
  return `The publisher never started (${raw.split("\n")[0]}). This is not a player or catalog problem.`;
}

function playerErrorForFailedJob({ jobStatus, jobError } = {}) {
  if (jobStatus !== "failed") return null;
  return humanizeJobError(jobError);
}

function noMediaFailMessage({ catalogReady, namespace, jobStatus, jobError } = {}) {
  const jobFail = playerErrorForFailedJob({ jobStatus, jobError });
  if (jobFail) return jobFail;
  if (catalogReady) {
    return "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.";
  }
  const ns = (namespace || "").trim();
  if (jobStatus === "completed") {
    return ns
      ? `MoQ publisher never announced namespace ${ns} on the relay. Encode ran but the catalog is not live — this is not a player 0x10 miss.`
      : "MoQ publisher never announced the namespace on the relay. Encode ran but the catalog is not live — this is not a player 0x10 miss.";
  }
  return ns
    ? `MoQ catalog never loaded on namespace ${ns}. Publisher must be live; a 0x10 subscribe miss is not OK.`
    : "MoQ catalog never loaded. Publisher must be live; a 0x10 subscribe miss is not OK.";
}

const capture251 =
  "Shared webcam capture exited immediately (code 251): Selected framerate (30.000000) is not supported";

assert.equal(isCaptureOrPublishError(capture251), true);
assert.equal(isCaptureOrPublishError("MoQ catalog never loaded"), false);

const shown = playerErrorForFailedJob({ jobStatus: "failed", jobError: capture251 });
assert.match(shown ?? "", /could not start/i);
assert.doesNotMatch(shown ?? "", /catalog never loaded/i);

const catalogOnly = noMediaFailMessage({
  catalogReady: false,
  namespace: "bench-896442c0",
});
assert.match(catalogOnly, /catalog never loaded/i);
assert.match(catalogOnly, /bench-896442c0/);

const jobBeatsCatalog = noMediaFailMessage({
  catalogReady: false,
  namespace: "bench-896442c0",
  jobStatus: "failed",
  jobError: capture251,
});
assert.match(jobBeatsCatalog, /could not start/i);
assert.doesNotMatch(jobBeatsCatalog, /catalog never loaded/i);

assert.equal(playerErrorForFailedJob({ jobStatus: "running", jobError: capture251 }), null);

const encodeOnly = noMediaFailMessage({
  catalogReady: false,
  namespace: "bench-733f1d7c",
  jobStatus: "completed",
});
assert.match(encodeOnly, /never announced namespace bench-733f1d7c/i);
assert.doesNotMatch(encodeOnly, /0x10 subscribe miss is not OK/);

console.log("unit-job-error-catalog: PASS");
