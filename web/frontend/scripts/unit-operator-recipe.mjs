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
assert.match(src, /linode_moq_relay/);
assert.match(src, /gcp_east_moq_relay/);
assert.match(src, /linode_mediamtx/);
assert.match(src, /gcp_east_mediamtx/);

const app = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx"),
  "utf8",
);
assert.match(app, /parseOperatorSearch/);
assert.match(app, /operatorEndpoints/);

const OUTPUTS = {
  linode_moq: { protocol: "moq", ingestEndpointId: "linode_moq_relay", playbackMode: "moq" },
  linode_webrtc: { protocol: "webrtc", ingestEndpointId: "linode_mediamtx", playbackMode: "whep" },
  east_moq: { protocol: "moq", ingestEndpointId: "gcp_east_moq_relay", playbackMode: "moq" },
  east_webrtc: { protocol: "webrtc", ingestEndpointId: "gcp_east_mediamtx", playbackMode: "whep" },
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
  if (!source && (operator || "").trim().toLowerCase() === "browser4") {
    source = "browser_moq";
  }
  const keys =
    (operator || "").trim().toLowerCase() === "browser4"
      ? ["linode_moq", "linode_webrtc", "east_moq", "east_webrtc"]
      : (params.get("outputs") || "")
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
  return { source, outputs: keys.map((key) => OUTPUTS[key]).filter(Boolean) };
}

const four = parseOperatorSearch("?operator=browser4");
assert.equal(four.source, "browser_moq");
assert.deepEqual(
  four.outputs.map((item) => [item.protocol, item.ingestEndpointId]),
  [
    ["moq", "linode_moq_relay"],
    ["webrtc", "linode_mediamtx"],
    ["moq", "gcp_east_moq_relay"],
    ["webrtc", "gcp_east_mediamtx"],
  ],
);

const explicit = parseOperatorSearch(
  "?source=browser&outputs=linode_moq,linode_webrtc,east_moq,east_webrtc",
);
assert.equal(explicit.source, "browser_moq");
assert.equal(explicit.outputs.length, 4);

const webcam = parseOperatorSearch("?source=webcam");
assert.equal(webcam.source, "webcam");
assert.equal(webcam.outputs.length, 0);

console.log("unit-operator-recipe: PASS");
