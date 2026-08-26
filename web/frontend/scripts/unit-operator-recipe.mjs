/**
 * Operator deep-links pre-select Source + the comparison-15 four-way
 * (Linode + GCP East × MoQ + WebRTC). Mirrors operatorRecipe.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/operatorRecipe.ts"),
  "utf8",
);
assert.match(src, /operator=browser4/);
assert.match(src, /operator=playa/);
assert.match(src, /linode_moq_relay_d18/);
assert.match(src, /gcp_east_moq_relay_d18/);
assert.match(src, /linode_mediamtx/);
assert.match(src, /gcp_east_mediamtx/);

const app = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx"),
  "utf8",
);
assert.match(app, /parseOperatorSearch/);
assert.match(app, /operatorEndpoints/);
assert.match(app, /operatorBenchmarkPreset/);
assert.match(src, /webrtc-vs-moq/);

const OUTPUTS = {
  linode_moq: { protocol: "moq", ingestEndpointId: "linode_moq_relay_d18", playbackMode: "moq" },
  linode_webrtc: { protocol: "webrtc", ingestEndpointId: "linode_mediamtx", playbackMode: "whep" },
  east_moq: { protocol: "moq", ingestEndpointId: "gcp_east_moq_relay_d18", playbackMode: "moq" },
  east_webrtc: { protocol: "webrtc", ingestEndpointId: "gcp_east_mediamtx", playbackMode: "whep" },
  gcp_d18: { protocol: "moq", ingestEndpointId: "gcp_moq_relay_d18", playbackMode: "moq" },
  west_d18: { protocol: "moq", ingestEndpointId: "gcp_moq_relay_d18", playbackMode: "moq" },
  gcp_d16: { protocol: "moq", ingestEndpointId: "gcp_moq_relay", playbackMode: "moq" },
};

function parseOperatorSource(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "browser" || value === "browser_moq") return "browser_moq";
  if (value === "webcam" || value === "local") return "webcam";
  if (value === "dummy" || value === "cloud") return "dummy";
  if (value === "bbb") return "bbb";
  return null;
}

function parseOperatorSearch(search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const operator = params.get("operator");
  let source = parseOperatorSource(params.get("source"));
  const op = (operator || "").trim().toLowerCase();
  if (!source && op === "browser4") {
    source = "browser_moq";
  }
  if (!source && (op === "playa" || op === "playa-webcam")) {
    source = "webcam";
  }
  if (!source && op === "playa-file") {
    source = "bbb";
  }
  const keys =
    op === "browser4"
      ? ["linode_moq", "linode_webrtc", "east_moq", "east_webrtc"]
      : op === "playa" || op === "playa-webcam" || op === "playa-file"
        ? ["gcp_d18"]
        : (params.get("outputs") || "")
            .split(",")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean);
  const encoderRaw = (params.get("encoder") || "").trim().toLowerCase();
  let encoder =
    encoderRaw === "obs" || encoderRaw === "openmoq"
      ? "obs"
      : encoderRaw === "ffmpeg" || encoderRaw === "helper"
        ? "ffmpeg"
        : encoderRaw === "browser" || encoderRaw === "webcodecs" || encoderRaw === "browser_moq"
          ? "browser"
          : null;
  if (encoder === "obs" && source !== "webcam") {
    source = "webcam";
  }
  if (source === "browser_moq" && !encoder) {
    encoder = "browser";
  }
  if (encoder === "browser" && source !== "webcam" && source !== "browser_moq") {
    source = source ?? "webcam";
  }
  if (!encoder && (op === "playa" || op === "playa-webcam")) {
    encoder = "ffmpeg";
  }
  return { source, encoder, outputs: keys.map((key) => OUTPUTS[key]).filter(Boolean) };
}

const four = parseOperatorSearch("?operator=browser4");
assert.equal(four.source, "browser_moq");
assert.equal(four.encoder, "browser");
assert.deepEqual(
  four.outputs.map((item) => [item.protocol, item.ingestEndpointId]),
  [
    ["moq", "linode_moq_relay_d18"],
    ["webrtc", "linode_mediamtx"],
    ["moq", "gcp_east_moq_relay_d18"],
    ["webrtc", "gcp_east_mediamtx"],
  ],
);

const explicit = parseOperatorSearch(
  "?source=browser&outputs=linode_moq,linode_webrtc,east_moq,east_webrtc",
);
assert.equal(explicit.source, "browser_moq");
assert.equal(explicit.encoder, "browser");
assert.equal(explicit.outputs.length, 4);

const webcamBrowser = parseOperatorSearch("?source=webcam&encoder=browser");
assert.equal(webcamBrowser.source, "webcam");
assert.equal(webcamBrowser.encoder, "browser");

const webcam = parseOperatorSearch("?source=webcam");
assert.equal(webcam.source, "webcam");
assert.equal(webcam.encoder, null);
assert.equal(webcam.outputs.length, 0);

const webcamFfmpeg = parseOperatorSearch("?source=webcam&encoder=ffmpeg");
assert.equal(webcamFfmpeg.source, "webcam");
assert.equal(webcamFfmpeg.encoder, "ffmpeg");

const webcamObs = parseOperatorSearch("?source=webcam&encoder=obs");
assert.equal(webcamObs.source, "webcam");
assert.equal(webcamObs.encoder, "obs");

const obsAlone = parseOperatorSearch("?encoder=obs");
assert.equal(obsAlone.source, "webcam");
assert.equal(obsAlone.encoder, "obs");

assert.match(src, /encoder=obs/);
assert.match(src, /parseOperatorEncoder/);
assert.match(src, /operator=playa/);
assert.match(src, /gcp_moq_relay_d18/);

const playa = parseOperatorSearch("?operator=playa");
assert.equal(playa.source, "webcam");
assert.equal(playa.encoder, "ffmpeg");
assert.deepEqual(playa.outputs.map((item) => item.ingestEndpointId), ["gcp_moq_relay_d18"]);

const playaFile = parseOperatorSearch("?operator=playa-file");
assert.equal(playaFile.source, "bbb");
assert.deepEqual(playaFile.outputs.map((item) => item.ingestEndpointId), ["gcp_moq_relay_d18"]);

const westD18 = parseOperatorSearch("?source=webcam&outputs=gcp_d18");
assert.equal(westD18.source, "webcam");
assert.deepEqual(westD18.outputs.map((item) => item.ingestEndpointId), ["gcp_moq_relay_d18"]);

console.log("unit-operator-recipe: PASS");
