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
    text.includes("catalog is not live") ||
    text.includes("webtransport session never connected") ||
    text.includes("no connection_id") ||
    text.includes("did not connect to the relay") ||
    text.includes("camera i/o error") ||
    text.includes("publish i/o error") ||
    text.includes("ffmpeg i/o error") ||
    text.includes("[errno 5]") ||
    text.includes("moq5-fmp4-publish not found") ||
    text.includes("failed to start moq publisher") ||
    text.includes("obs websocket") ||
    text.includes("startstream failed") ||
    text.includes("openmoq-plugin")
  );
}

function humanizeJobError(error) {
  const raw = (error || "").trim();
  if (!raw) return null;
  if (/one-shot catalog miss|catalog object never reached/i.test(raw)) return raw;
  if (!isCaptureOrPublishError(raw)) return raw;
  if (/camera i\/o error|framerate|avfoundation|shared webcam/i.test(raw)) {
    return "The camera on this laptop could not start, so nothing was published. This is not a player or catalog problem.";
  }
  if (/^\[errno 5\]\s*input\/output error$/i.test(raw) || /^input\/output error$/i.test(raw)) {
    return "Capture or publisher I/O failed. The camera may be busy, or the encoder wrote to a closed publisher pipe. This is not a player or catalog problem.";
  }
  const first = raw.split("\n")[0];
  if (/publish i\/o error|ffmpeg i\/o error|closed publisher pipe/i.test(raw)) {
    return `The publisher pipe closed before encode finished (${first}). This is not a player or catalog problem.`;
  }
  if (/moq5-fmp4-publish not found|failed to start moq publisher/i.test(raw)) {
    return `The publisher never started (${first}). This is not a player or catalog problem.`;
  }
  if (/webtransport session never connected|no connection_id|did not connect to the relay/i.test(raw)) {
    return `The publisher ran but did not connect to the relay (${first}). This is not a player or catalog problem.`;
  }
  if (/never announced namespace|catalog is not live/i.test(raw)) {
    return first;
  }
  if (/obs websocket|startstream failed|openmoq-plugin|obs openmoq/i.test(raw)) {
    return first;
  }
  return first;
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

const cameraEio = "camera I/O error: [Errno 5] Input/output error. The camera may be busy.";
assert.equal(isCaptureOrPublishError(cameraEio), true);
assert.match(humanizeJobError(cameraEio) ?? "", /could not start/i);
const bareEio = humanizeJobError("[Errno 5] Input/output error") ?? "";
assert.doesNotMatch(bareEio, /\[Errno 5\]/);
assert.doesNotMatch(bareEio, /catalog never loaded/i);
assert.match(bareEio, /I\/O failed/i);
assert.doesNotMatch(bareEio, /could not start/i);
assert.match(
  humanizeJobError("moq5-fmp4-publish not found, run scripts/install-moq5.sh") ?? "",
  /publisher never started/i,
);

assert.equal(playerErrorForFailedJob({ jobStatus: "running", jobError: capture251 }), null);

const encodeOnly = noMediaFailMessage({
  catalogReady: false,
  namespace: "bench-733f1d7c",
  jobStatus: "completed",
});
assert.match(encodeOnly, /never announced namespace bench-733f1d7c/i);
assert.doesNotMatch(encodeOnly, /0x10 subscribe miss is not OK/);

const catalogNotLive =
  "MoQ publisher never announced namespace bench-b565262f on the relay. Encode produced CMAF but the catalog is not live.";
assert.equal(isCaptureOrPublishError(catalogNotLive), true);
assert.doesNotMatch(humanizeJobError(catalogNotLive) ?? "", /publisher never started/i);
assert.match(humanizeJobError(catalogNotLive) ?? "", /catalog is not live/i);

const wtNever =
  `${catalogNotLive} WebTransport session never connected (no connection_id).`;
assert.match(humanizeJobError(wtNever) ?? "", /did not connect to the relay/i);
assert.doesNotMatch(humanizeJobError(wtNever) ?? "", /publisher never started/i);

const spawnFail = "Failed to start MoQ publisher /tmp/moq5-fmp4-publish: [Errno 5] Input/output error";
assert.match(humanizeJobError(spawnFail) ?? "", /publisher never started/i);

const oneShot =
  "MoQ namespace bench-de7b38dd is live on the relay but the catalog object never reached this player (one-shot catalog miss).";
assert.doesNotMatch(humanizeJobError(oneShot) ?? "", /publisher never started/i);
assert.match(humanizeJobError(oneShot) ?? "", /catalog object never reached/i);

const obsEio =
  "OBS WebSocket I/O error ([Errno 5] Input/output error). Check Tools → WebSocket Server and that OBS is still running.";
assert.doesNotMatch(humanizeJobError(obsEio) ?? "", /publisher never started/i);
assert.match(humanizeJobError(obsEio) ?? "", /OBS WebSocket I\/O/i);

console.log("unit-job-error-catalog: PASS");
