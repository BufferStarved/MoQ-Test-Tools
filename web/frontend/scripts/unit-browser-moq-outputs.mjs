/**
 * Browser publish collapse: MoQ and/or WebRTC (WHIP). Leftover SRT/RTMP
 * cards convert first → MoQ, next → WebRTC.
 */
import assert from "node:assert/strict";

function isCustom(id) {
  return id === "custom";
}

function cloudHostFromIngest(id) {
  if (String(id).startsWith("gcp_east_")) return "gcp_east";
  if (String(id).startsWith("linode_")) return "linode";
  if (String(id).startsWith("aws_")) return "aws";
  return "gcp";
}

function defaultIngestForProtocol(protocol, host = "gcp") {
  const prefix = host === "gcp_east" ? "gcp_east" : host === "linode" || host === "aws" ? host : "gcp";
  if (protocol === "moq") return `${prefix}_moq_relay`;
  if (protocol === "srt" || protocol === "webrtc") return `${prefix}_mediamtx`;
  return `${prefix}_zixi`;
}

function browserPublishIngestId(endpoint) {
  if (endpoint.protocol === "webrtc") {
    return defaultIngestForProtocol("webrtc", cloudHostFromIngest(endpoint.ingestEndpointId));
  }
  return defaultIngestForProtocol("moq", cloudHostFromIngest(endpoint.ingestEndpointId));
}

function collapseOutputsForBrowserMoq(endpoints) {
  const result = [];
  const seen = new Set();
  let changed = false;
  let assignedMoq = false;
  for (const endpoint of endpoints) {
    let protocol = endpoint.protocol;
    let ingest = endpoint.ingestEndpointId;
    let playbackMode = endpoint.playbackMode;
    if (protocol !== "moq" && protocol !== "webrtc") {
      if (!assignedMoq) {
        protocol = "moq";
        ingest = defaultIngestForProtocol("moq", cloudHostFromIngest(endpoint.ingestEndpointId));
        playbackMode = "moq";
      } else {
        protocol = "webrtc";
        ingest = defaultIngestForProtocol("webrtc", cloudHostFromIngest(endpoint.ingestEndpointId));
        playbackMode = "whep";
      }
      changed = true;
    } else {
      ingest = browserPublishIngestId({ protocol, ingestEndpointId: ingest });
      if (endpoint.ingestEndpointId !== ingest) changed = true;
      if (protocol === "moq") playbackMode = "moq";
      else if (!playbackMode || playbackMode === "moq") playbackMode = "whep";
    }
    const key = isCustom(ingest)
      ? `${protocol}:custom:${(endpoint.moqRelayUrl || endpoint.endpointUrl || "").trim()}`
      : `${protocol}:${ingest}`;
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    if (protocol === "moq") assignedMoq = true;
    if (
      endpoint.protocol === protocol &&
      endpoint.ingestEndpointId === ingest &&
      endpoint.playbackMode === playbackMode
    ) {
      result.push(endpoint);
      continue;
    }
    changed = true;
    result.push({ ...endpoint, protocol, ingestEndpointId: ingest, playbackMode });
  }
  return changed ? result : endpoints;
}

const sameCloud = collapseOutputsForBrowserMoq([
  { id: "1", protocol: "rtmp", ingestEndpointId: "gcp_zixi" },
  { id: "2", protocol: "srt", ingestEndpointId: "gcp_mediamtx" },
  { id: "3", protocol: "moq", ingestEndpointId: "gcp_moq_relay" },
]);
assert.equal(sameCloud.length, 2);
assert.equal(sameCloud[0].protocol, "moq");
assert.equal(sameCloud[0].ingestEndpointId, "gcp_moq_relay");
assert.equal(sameCloud[1].protocol, "webrtc");
assert.equal(sameCloud[1].ingestEndpointId, "gcp_mediamtx");
assert.equal(sameCloud[1].playbackMode, "whep");

const twoDefault = collapseOutputsForBrowserMoq([
  { id: "1", protocol: "rtmp", ingestEndpointId: "gcp_zixi" },
  { id: "2", protocol: "srt", ingestEndpointId: "gcp_mediamtx" },
]);
assert.deepEqual(
  twoDefault.map((item) => [item.protocol, item.ingestEndpointId]),
  [
    ["moq", "gcp_moq_relay"],
    ["webrtc", "gcp_mediamtx"],
  ],
);

const threeClouds = collapseOutputsForBrowserMoq([
  { id: "1", protocol: "rtmp", ingestEndpointId: "gcp_east_zixi" },
  { id: "2", protocol: "srt", ingestEndpointId: "linode_mediamtx" },
  { id: "3", protocol: "moq", ingestEndpointId: "gcp_moq_relay" },
]);
assert.equal(threeClouds.length, 3);
assert.deepEqual(
  threeClouds.map((item) => item.ingestEndpointId),
  ["gcp_east_moq_relay", "linode_mediamtx", "gcp_moq_relay"],
);

const identity = [{ id: "1", protocol: "moq", ingestEndpointId: "gcp_moq_relay", playbackMode: "moq" }];
assert.equal(collapseOutputsForBrowserMoq(identity), identity);

const browser4 = collapseOutputsForBrowserMoq([
  { id: "1", protocol: "moq", ingestEndpointId: "linode_moq_relay", playbackMode: "moq" },
  { id: "2", protocol: "webrtc", ingestEndpointId: "linode_mediamtx", playbackMode: "whep" },
  { id: "3", protocol: "moq", ingestEndpointId: "gcp_east_moq_relay", playbackMode: "moq" },
  { id: "4", protocol: "webrtc", ingestEndpointId: "gcp_east_mediamtx", playbackMode: "whep" },
]);
assert.deepEqual(
  browser4.map((item) => [item.protocol, item.ingestEndpointId, item.playbackMode]),
  [
    ["moq", "linode_moq_relay", "moq"],
    ["webrtc", "linode_mediamtx", "whep"],
    ["moq", "gcp_east_moq_relay", "moq"],
    ["webrtc", "gcp_east_mediamtx", "whep"],
  ],
);

const custom = collapseOutputsForBrowserMoq([
  { id: "1", protocol: "moq", ingestEndpointId: "custom", playbackMode: "moq" },
]);
assert.equal(custom[0].ingestEndpointId, "gcp_moq_relay");

console.log("unit-browser-moq-outputs: ok");
