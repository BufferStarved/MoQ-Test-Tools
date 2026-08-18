/**
 * Output-config colors: same only when protocol+ingest+player match;
 * two SRT legs to different clouds must not share a hue.
 */
import assert from "node:assert/strict";

const STREAM_COLORS = [
  "#22d3ee",
  "#f472b6",
  "#a78bfa",
  "#4ade80",
  "#fb923c",
  "#facc15",
  "#60a5fa",
  "#2dd4bf",
];

function outputConfigKey(config) {
  const protocol = (config.protocol ?? "").trim().toLowerCase();
  const ingest = (config.ingestEndpointId ?? "").trim().toLowerCase();
  const playback = (config.playbackMode ?? "").trim().toLowerCase();
  const endpoint = (config.endpoint ?? "").trim().toLowerCase();
  if (protocol || ingest || playback) {
    return `${protocol}|${ingest}|${playback}`;
  }
  return endpoint;
}

function assignStreamColors(configs) {
  const assigned = new Map();
  let next = 0;
  return configs.map((config, index) => {
    const key = outputConfigKey(config) || `leg-${index}`;
    const existing = assigned.get(key);
    if (existing) {
      return existing;
    }
    const color = STREAM_COLORS[next % STREAM_COLORS.length];
    next += 1;
    assigned.set(key, color);
    return color;
  });
}

const threeSrts = assignStreamColors([
  { protocol: "srt", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
  { protocol: "srt", ingestEndpointId: "linode_zixi", playbackMode: "mpegts" },
  { protocol: "srt", ingestEndpointId: "gcp_east_zixi", playbackMode: "mpegts" },
]);
assert.equal(new Set(threeSrts).size, 3);

const twoMoq = assignStreamColors([
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay", playbackMode: "moq" },
  { protocol: "moq", ingestEndpointId: "linode_moq_relay", playbackMode: "moq" },
]);
assert.equal(new Set(twoMoq).size, 2);

const sameConfig = assignStreamColors([
  { protocol: "srt", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
  { protocol: "srt", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
]);
assert.equal(sameConfig[0], sameConfig[1]);

console.log("unit-stream-colors: PASS");
