/**
 * Exhaustive recipe-support matrix: every source × protocol × ingest × player
 * combo is either legal or must be rejected / remapped. Mirrors
 * web/frontend/src/recipeSupport.ts, ingestEndpoints.ts, playbackUrls.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recipeSrc = fs.readFileSync(path.join(root, "src/recipeSupport.ts"), "utf8");
const ingestSrc = fs.readFileSync(path.join(root, "src/ingestEndpoints.ts"), "utf8");
const playbackSrc = fs.readFileSync(path.join(root, "src/playbackUrls.ts"), "utf8");
const endpointSrc = fs.readFileSync(path.join(root, "src/EndpointSection.tsx"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");

assert.match(appSrc, /coerceRecipe/);
assert.match(appSrc, /recipeIssue/);
assert.match(appSrc, /canAddRecipeOutput/);
assert.match(appSrc, /Boolean\(recipeBlockReason\)/);
assert.match(endpointSrc, /destinationsForProtocol/);
assert.match(endpointSrc, /selectablePlaybackModes/);
assert.doesNotMatch(endpointSrc, /playbackModeBlockedReason/);
assert.match(endpointSrc, /UPLOAD_PROTOCOLS_COMING_SOON = new Set\(\["hls", "dash"\]\)/);
assert.match(recipeSrc, /PUBLISH_PROTOCOL_IDS = \["srt", "rtmp", "webrtc", "moq"\]/);
assert.match(playbackSrc, /Compatible players only/);
assert.match(ingestSrc, /RECIPE_HIDDEN_INGEST_IDS/);
assert.match(recipeSrc, /publishProtocolIdsForSource/);

const SOURCES = ["dummy", "bbb", "upload", "webcam", "browser_moq"];
const PROTOCOLS = ["srt", "rtmp", "webrtc", "moq", "hls", "dash"];
const INGESTS = [
  "gcp_zixi",
  "gcp_mediamtx",
  "gcp_moq_relay",
  "gcp_east_zixi",
  "gcp_east_mediamtx",
  "gcp_east_moq_relay",
  "linode_zixi",
  "linode_mediamtx",
  "linode_moq_relay",
  "aws_zixi",
  "custom",
];
const PLAYERS = [
  "auto",
  "hls",
  "ll-hls",
  "dash",
  "ll-dash",
  "webrtc",
  "whep",
  "moq",
  "mpegts",
  "zixi-embed",
];

const CHROME = { safari: false, webTransport: true, rtcPeerConnection: true };
const SAFARI = { safari: true, webTransport: false, rtcPeerConnection: true };
const NO_WT = { safari: false, webTransport: false, rtcPeerConnection: true };

function ingestRole(id) {
  const value = String(id);
  if (value.endsWith("_moq_relay")) return "moq_relay";
  if (value.endsWith("_mediamtx")) return "mediamtx";
  if (value.endsWith("_zixi")) return "zixi";
  return null;
}

function isPlaybackModeCompatible(mode, protocol, ingestEndpointId = "") {
  if (mode === "auto") return false;
  if (protocol === "moq") return mode === "moq";
  if (mode === "moq") return false;
  if (protocol === "webrtc") {
    if (ingestEndpointId && ingestRole(ingestEndpointId) === "mediamtx") {
      return mode === "whep" || mode === "ll-hls" || mode === "ll-dash" || mode === "hls" || mode === "mpegts";
    }
    return mode === "whep";
  }
  const mediamtx = ingestRole(ingestEndpointId) === "mediamtx";
  const zixi = ingestRole(ingestEndpointId) === "zixi";
  if (mediamtx) {
    return mode === "ll-hls" || mode === "ll-dash" || mode === "hls" || mode === "whep" || mode === "mpegts";
  }
  if (zixi) {
    return mode === "hls" || mode === "mpegts";
  }
  if (protocol === "srt" || protocol === "rtmp" || protocol === "hls" || protocol === "dash") {
    return mode === "hls" || mode === "mpegts" || mode === "whep";
  }
  return false;
}

function protocolAllowed(protocol, caps) {
  if (protocol === "moq") return caps.webTransport && !caps.safari;
  if (protocol === "webrtc") return caps.rtcPeerConnection;
  return protocol === "srt" || protocol === "rtmp";
}

function playerAllowed(mode, caps) {
  if (mode === "moq") return caps.webTransport && !caps.safari;
  if (mode === "whep") return caps.rtcPeerConnection;
  if (caps.safari) return mode === "hls" || mode === "ll-hls";
  return true;
}

function ingestHidden(id) {
  // Product RECIPE_HIDDEN_INGEST_IDS is empty; only the AWS stub is unconfigured.
  return id === "aws_zixi";
}

function ingestMatchesProtocol(protocol, ingest) {
  if (ingest === "custom") return true;
  const role = ingestRole(ingest);
  if (protocol === "moq") return role === "moq_relay";
  if (protocol === "webrtc") return role === "mediamtx";
  if (protocol === "srt" || protocol === "rtmp") return role === "zixi" || role === "mediamtx";
  return false;
}

function isLegalCombo(source, protocol, ingest, player, caps, publisher = { localFfmpegWhip: true }) {
  const sourceProtocols =
    source === "browser_moq" ? ["moq", "webrtc"] : ["srt", "rtmp", "webrtc", "moq"];
  if (!sourceProtocols.includes(protocol)) return false;
  if (!protocolAllowed(protocol, caps)) return false;
  if (protocol === "webrtc" && source === "webcam" && !publisher.localFfmpegWhip) return false;
  if (ingestHidden(ingest)) return false;
  if (ingest === "custom" && source === "browser_moq") return false;
  if (!ingestMatchesProtocol(protocol, ingest)) return false;
  if (!isPlaybackModeCompatible(player, protocol, ingest)) return false;
  if (!playerAllowed(player, caps)) return false;
  return true;
}

function collisionKey(ingest, protocol) {
  if (protocol === "moq" || ingest === "custom") return null;
  if (String(ingest).endsWith("_mediamtx")) return ingest;
  if (String(ingest).endsWith("_zixi")) return `${ingest}:${protocol === "srt" ? "srt" : "benchmark"}`;
  return `${ingest}:${protocol}`;
}

const chromeLegal = [];
const chromeIllegal = [];
for (const source of SOURCES) {
  for (const protocol of PROTOCOLS) {
    for (const ingest of INGESTS) {
      for (const player of PLAYERS) {
        const ok = isLegalCombo(source, protocol, ingest, player, CHROME);
        (ok ? chromeLegal : chromeIllegal).push([source, protocol, ingest, player]);
      }
    }
  }
}

assert.ok(chromeLegal.length > 40, `expected a real legal set, got ${chromeLegal.length}`);
assert.ok(chromeIllegal.length > chromeLegal.length, "most combos must be illegal");

// Known-good Chrome ffmpeg recipes
for (const row of [
  ["dummy", "srt", "gcp_mediamtx", "ll-hls"],
  ["dummy", "srt", "gcp_mediamtx", "mpegts"],
  ["dummy", "srt", "gcp_zixi", "mpegts"],
  ["dummy", "srt", "gcp_zixi", "hls"],
  ["dummy", "srt", "gcp_east_zixi", "mpegts"],
  ["dummy", "srt", "gcp_east_zixi", "hls"],
  ["dummy", "rtmp", "linode_zixi", "hls"],
  ["dummy", "rtmp", "gcp_mediamtx", "whep"],
  ["dummy", "webrtc", "gcp_east_mediamtx", "whep"],
  ["dummy", "webrtc", "gcp_mediamtx", "ll-hls"],
  ["dummy", "webrtc", "gcp_mediamtx", "hls"],
  ["dummy", "moq", "linode_moq_relay", "moq"],
  ["dummy", "srt", "custom", "hls"],
  ["webcam", "rtmp", "gcp_east_zixi", "mpegts"],
  ["browser_moq", "moq", "gcp_moq_relay", "moq"],
  ["browser_moq", "webrtc", "linode_mediamtx", "whep"],
]) {
  assert.equal(isLegalCombo(...row, CHROME), true, row.join("/"));
}

// Known-illegal
for (const row of [
  ["dummy", "srt", "gcp_moq_relay", "moq"],
  ["dummy", "webrtc", "gcp_east_zixi", "whep"],
  ["dummy", "moq", "gcp_mediamtx", "moq"],
  ["dummy", "hls", "gcp_east_zixi", "mpegts"],
  ["dummy", "dash", "custom", "hls"],
  ["dummy", "srt", "aws_zixi", "mpegts"],
  ["dummy", "srt", "gcp_mediamtx", "dash"],
  ["browser_moq", "srt", "gcp_mediamtx", "ll-hls"],
  ["browser_moq", "moq", "custom", "moq"],
  ["browser_moq", "rtmp", "gcp_east_zixi", "hls"],
]) {
  assert.equal(isLegalCombo(...row, CHROME), false, row.join("/"));
}

assert.equal(
  isLegalCombo("webcam", "webrtc", "gcp_mediamtx", "whep", CHROME, { localFfmpegWhip: false }),
  false,
  "webcam webrtc without laptop WHIP muxer",
);
assert.equal(
  isLegalCombo("webcam", "webrtc", "gcp_mediamtx", "whep", CHROME, { localFfmpegWhip: true }),
  true,
  "webcam webrtc with laptop WHIP muxer",
);
assert.equal(
  isLegalCombo("dummy", "webrtc", "gcp_mediamtx", "whep", CHROME, { localFfmpegWhip: false }),
  true,
  "cloud dummy webrtc does not need laptop WHIP",
);

// Safari: no MoQ / MPEG-TS; Zixi SRT can still use Fast HLS; HLS on MTX is ok
assert.equal(isLegalCombo("dummy", "moq", "gcp_moq_relay", "moq", SAFARI), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_east_zixi", "mpegts", SAFARI), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_east_zixi", "hls", SAFARI), true);
assert.equal(isLegalCombo("dummy", "srt", "gcp_mediamtx", "ll-hls", SAFARI), true);
assert.equal(isLegalCombo("dummy", "rtmp", "gcp_east_zixi", "hls", SAFARI), true);
assert.equal(isLegalCombo("dummy", "webrtc", "gcp_mediamtx", "whep", SAFARI), true);
assert.equal(isLegalCombo("browser_moq", "moq", "gcp_moq_relay", "moq", SAFARI), false);
assert.equal(isLegalCombo("browser_moq", "webrtc", "gcp_mediamtx", "whep", SAFARI), true);

assert.equal(isLegalCombo("dummy", "moq", "gcp_moq_relay", "moq", NO_WT), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_mediamtx", "ll-hls", NO_WT), true);

// Collision keys: SRT+RTMP on the same MediaMTX share a path; Zixi SRT does not
assert.equal(collisionKey("gcp_mediamtx", "srt"), collisionKey("gcp_mediamtx", "rtmp"));
assert.notEqual(collisionKey("gcp_east_zixi", "srt"), collisionKey("gcp_east_zixi", "rtmp"));
assert.equal(collisionKey("gcp_moq_relay", "moq"), null);

// Every Chrome-legal protocol×ingest pair has at least one legal player
const pairs = new Set(chromeLegal.map(([, proto, ing]) => `${proto}\0${ing}`));
for (const key of pairs) {
  const [proto, ing] = key.split("\0");
  const hasPlayer = PLAYERS.some((player) => isLegalCombo("dummy", proto, ing, player, CHROME));
  assert.equal(hasPlayer, true, `${proto}/${ing} must have a player`);
}

console.log(
  `unit-recipe-support: PASS (${chromeLegal.length} legal / ${chromeIllegal.length} illegal Chrome combos)`,
);
