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
const destGridSrc = fs.readFileSync(path.join(root, "src/DestinationGrid.tsx"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");

assert.match(appSrc, /coerceRecipe/);
assert.match(appSrc, /recipeIssue/);
assert.match(appSrc, /canAddRecipeOutput/);
assert.match(appSrc, /Boolean\(startTitle\)/);
assert.match(appSrc, /recipeBlockReason/);
assert.match(endpointSrc, /destinationsForProtocol/);
assert.match(endpointSrc, /includeOccupied:\s*true/);
assert.match(endpointSrc, /occupiedCollisionKeys=\{occupiedCollisionKeys\}/);
assert.match(endpointSrc, /lockProtocol/);
assert.match(destGridSrc, /data-testid="output-destination"/);
assert.match(endpointSrc, /selectablePlaybackModes/);
assert.doesNotMatch(endpointSrc, /playbackModeBlockedReason/);
assert.match(endpointSrc, /UPLOAD_PROTOCOLS_COMING_SOON = new Set\(\["hls", "dash"\]\)/);
assert.match(recipeSrc, /PUBLISH_PROTOCOL_IDS = \["srt", "rtmp", "webrtc", "moq"\]/);
assert.match(playbackSrc, /Compatible players only/);
assert.match(ingestSrc, /RECIPE_HIDDEN_INGEST_IDS/);
assert.match(ingestSrc, /_moq_relay_d18` as IngestEndpointId/);
assert.match(ingestSrc, /label: "GCP Central"/);
assert.match(ingestSrc, /label: "GCP East"/);
assert.match(ingestSrc, /label: "Linode East"/);
assert.match(ingestSrc, /export function zixiFastHlsAvailable/);
assert.match(playbackSrc, /export function zixiOriginHasFastHls/);
assert.match(ingestSrc, /labelPrefix: "OpenMOQ"/);
assert.match(ingestSrc, /labelPrefix: "OpenMOQ draft-16"/);
assert.match(ingestSrc, /\$\{role\.labelPrefix\} · \$\{host\.label\}/);
assert.match(ingestSrc, /RECIPE_HIDDEN_INGEST_IDS[\s\S]*moq_relay/);
assert.match(recipeSrc, /publishProtocolIdsForSource/);
assert.match(recipeSrc, /isLocalAgentSource/);
assert.match(recipeSrc, /recipeEncoderForSource/);
assert.match(recipeSrc, /isBrowserPublish/);
assert.match(recipeSrc, /recipeRequiresMoq/);
assert.match(recipeSrc, /effective === "obs"/);
assert.match(appSrc, /encode-encoder-options/);
assert.match(appSrc, /encoderModeExplainer/);
assert.match(appSrc, /const MIN_ENDPOINTS = 1/);
assert.match(appSrc, /canRemove=\{showOutputConfig && endpoints.length > minEndpointsForSource/);
assert.doesNotMatch(appSrc, /OBS \+ OpenMOQ/);
assert.match(appSrc, /Calculates PSNR, SSIM and VMAF post transcode and post ingest/);
assert.doesNotMatch(appSrc, /setMediaSource\("dummy"\);\s*setMediaPath\(OBS_OPENMOQ_MEDIA\)/);
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "src/SourceSection.tsx"), "utf8"),
  /OBS Virtual Camera/,
);

const SOURCES = ["dummy", "bbb", "upload", "webcam", "browser_moq"];
const PROTOCOLS = ["srt", "rtmp", "webrtc", "moq", "hls", "dash"];
const INGESTS = [
  "gcp_zixi",
  "gcp_mediamtx",
  "gcp_moq_relay",
  "gcp_moq_relay_d18",
  "gcp_east_zixi",
  "gcp_east_mediamtx",
  "gcp_east_moq_relay",
  "gcp_east_moq_relay_d18",
  "linode_zixi",
  "linode_mediamtx",
  "linode_moq_relay",
  "linode_moq_relay_d18",
  "aws_east_zixi",
  "gcp_west_zixi",
  "linode_central_mediamtx",
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
  if (value.includes("_moq_relay")) return "moq_relay";
  if (value.endsWith("_mediamtx")) return "mediamtx";
  if (value.endsWith("_zixi")) return "zixi";
  return null;
}

function zixiFastHlsAvailable(id) {
  return id === "gcp_zixi";
}

function isPlaybackModeCompatible(mode, protocol, ingestEndpointId = "", endpointUrl = "") {
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
  const zixi =
    ingestRole(ingestEndpointId) === "zixi" ||
    /35\.196\.215\.179|45\.33\.68\.151|35\.222\.33\.58|:10080/.test(endpointUrl);
  if (mediamtx) {
    return mode === "ll-hls" || mode === "ll-dash" || mode === "hls" || mode === "whep" || mode === "mpegts";
  }
  if (zixi) {
    if (
      zixiFastHlsAvailable(ingestEndpointId) ||
      (ingestRole(ingestEndpointId) !== "zixi" && endpointUrl.includes("35.222.33.58"))
    ) {
      return mode === "hls" || mode === "mpegts";
    }
    return mode === "mpegts";
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
  if (String(id).includes("moq_relay") && !String(id).endsWith("_d18")) {
    return true;
  }
  return (
    id === "aws_zixi" ||
    id === "aws_east_zixi" ||
    id.startsWith("gcp_west_") ||
    id.startsWith("linode_central_") ||
    id.startsWith("linode_west_") ||
    id.startsWith("aws_")
  );
}

function ingestMatchesProtocol(protocol, ingest) {
  if (ingest === "custom") return true;
  const role = ingestRole(ingest);
  if (protocol === "moq") return role === "moq_relay";
  if (protocol === "webrtc") return role === "mediamtx";
  if (protocol === "srt" || protocol === "rtmp") return role === "zixi" || role === "mediamtx";
  return false;
}

function isLegalCombo(
  source,
  protocol,
  ingest,
  player,
  caps,
  publisher = { localFfmpegWhip: true },
  encoder = "ffmpeg",
) {
  const effective =
    source === "browser_moq" ? "browser" : source === "webcam" ? encoder : "ffmpeg";
  const sourceProtocols =
    effective === "browser" || source === "browser_moq"
      ? ["moq", "webrtc"]
      : ["srt", "rtmp", "webrtc", "moq"];
  if (!sourceProtocols.includes(protocol)) return false;
  if (!protocolAllowed(protocol, caps)) return false;
  // ffmpeg always offers WHIP; Start checks the laptop muxer.
  if (protocol === "webrtc" && effective === "obs") return false;
  if (effective === "obs" && protocol === "moq" && String(ingest).includes("moq_relay_d18")) {
    return false;
  }
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
  ["dummy", "srt", "gcp_zixi", "hls"],
  ["dummy", "srt", "gcp_zixi", "mpegts"],
  ["dummy", "srt", "gcp_east_zixi", "mpegts"],
  ["dummy", "rtmp", "linode_zixi", "mpegts"],
  ["dummy", "rtmp", "gcp_mediamtx", "whep"],
  ["dummy", "webrtc", "gcp_east_mediamtx", "whep"],
  ["dummy", "webrtc", "gcp_mediamtx", "ll-hls"],
  ["dummy", "webrtc", "gcp_mediamtx", "hls"],
  ["dummy", "moq", "linode_moq_relay_d18", "moq"],
  ["dummy", "srt", "custom", "hls"],
  ["webcam", "rtmp", "gcp_east_zixi", "mpegts"],
  ["browser_moq", "moq", "gcp_moq_relay_d18", "moq"],
  ["browser_moq", "webrtc", "linode_mediamtx", "whep"],
]) {
  assert.equal(isLegalCombo(...row, CHROME), true, row.join("/"));
}

// Known-illegal
for (const row of [
  ["dummy", "srt", "gcp_moq_relay", "moq"],
  ["dummy", "srt", "gcp_east_zixi", "hls"],
  ["dummy", "rtmp", "linode_zixi", "hls"],
  ["dummy", "webrtc", "gcp_east_zixi", "whep"],
  ["dummy", "moq", "gcp_mediamtx", "moq"],
  ["dummy", "hls", "gcp_east_zixi", "mpegts"],
  ["dummy", "dash", "custom", "hls"],
  ["dummy", "srt", "aws_east_zixi", "mpegts"],
  ["dummy", "moq", "gcp_moq_relay", "moq"],
  ["dummy", "moq", "linode_moq_relay", "moq"],
  ["dummy", "srt", "gcp_mediamtx", "dash"],
  ["browser_moq", "srt", "gcp_mediamtx", "ll-hls"],
  ["browser_moq", "moq", "custom", "moq"],
  ["browser_moq", "rtmp", "gcp_east_zixi", "hls"],
]) {
  assert.equal(isLegalCombo(...row, CHROME), false, row.join("/"));
}

assert.equal(
  isLegalCombo("webcam", "webrtc", "gcp_mediamtx", "whep", CHROME, { localFfmpegWhip: false }),
  true,
  "webcam ffmpeg still offers WebRTC; Start checks the WHIP muxer",
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

// Safari: no MoQ / MPEG-TS. Central Zixi still has Fast HLS; East/Linode do not.
assert.equal(isLegalCombo("dummy", "moq", "gcp_moq_relay", "moq", SAFARI), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_east_zixi", "mpegts", SAFARI), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_east_zixi", "hls", SAFARI), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_zixi", "hls", SAFARI), true);
assert.equal(isLegalCombo("dummy", "srt", "gcp_mediamtx", "ll-hls", SAFARI), true);
assert.equal(isLegalCombo("dummy", "rtmp", "gcp_east_zixi", "hls", SAFARI), false);
assert.equal(isLegalCombo("dummy", "rtmp", "gcp_zixi", "hls", SAFARI), true);
assert.equal(isLegalCombo("dummy", "webrtc", "gcp_mediamtx", "whep", SAFARI), true);
assert.equal(isLegalCombo("browser_moq", "moq", "gcp_moq_relay", "moq", SAFARI), false);
assert.equal(isLegalCombo("browser_moq", "webrtc", "gcp_mediamtx", "whep", SAFARI), true);

assert.equal(isLegalCombo("dummy", "moq", "gcp_moq_relay", "moq", NO_WT), false);
assert.equal(isLegalCombo("dummy", "srt", "gcp_mediamtx", "ll-hls", NO_WT), true);

assert.equal(
  isLegalCombo("webcam", "webrtc", "gcp_mediamtx", "whep", CHROME, { localFfmpegWhip: true }, "obs"),
  false,
  "OBS last-mile encoder has no WebRTC",
);
assert.equal(
  isLegalCombo("webcam", "moq", "gcp_moq_relay", "moq", CHROME, { localFfmpegWhip: true }, "obs"),
  false,
  "OBS last-mile encoder cannot use hidden draft-16 dests",
);
assert.equal(
  isLegalCombo("webcam", "moq", "gcp_east_moq_relay_d18", "moq", CHROME, { localFfmpegWhip: true }, "obs"),
  false,
  "OBS + draft-18 is not legal — plugin is draft-16 only",
);
assert.equal(
  isLegalCombo("webcam", "moq", "gcp_moq_relay_d18", "moq", CHROME, { localFfmpegWhip: true }, "ffmpeg"),
  true,
  "Webcam + ffmpeg + west draft-18 MoQ is legal",
);
assert.equal(
  isLegalCombo("webcam", "srt", "gcp_mediamtx", "ll-hls", CHROME, { localFfmpegWhip: true }, "obs"),
  true,
  "OBS last-mile encoder still offers SRT",
);
assert.equal(
  isLegalCombo("dummy", "webrtc", "gcp_mediamtx", "whep", CHROME, { localFfmpegWhip: true }, "obs"),
  true,
  "OBS encoder is ignored for cloud playout",
);
assert.equal(
  isLegalCombo("webcam", "moq", "gcp_moq_relay_d18", "moq", CHROME, { localFfmpegWhip: true }, "browser"),
  true,
  "Webcam + Browser engine maps to browser publish protocols",
);
assert.equal(
  isLegalCombo("webcam", "webrtc", "linode_mediamtx", "whep", CHROME, { localFfmpegWhip: true }, "browser"),
  true,
  "Webcam + Browser engine allows WebRTC",
);
assert.equal(
  isLegalCombo("webcam", "srt", "gcp_mediamtx", "ll-hls", CHROME, { localFfmpegWhip: true }, "browser"),
  false,
  "Webcam + Browser engine forbids SRT",
);
assert.equal(
  isLegalCombo("webcam", "srt", "gcp_mediamtx", "ll-hls", CHROME, { localFfmpegWhip: true }, "ffmpeg"),
  true,
  "Webcam + ffmpeg still allows SRT",
);
assert.equal(
  isLegalCombo("webcam", "rtmp", "gcp_zixi", "hls", CHROME, { localFfmpegWhip: true }, "ffmpeg"),
  true,
  "Webcam + ffmpeg still allows RTMP",
);
assert.equal(
  isLegalCombo("webcam", "moq", "gcp_moq_relay_d18", "moq", CHROME, { localFfmpegWhip: true }, "ffmpeg"),
  true,
  "Webcam + ffmpeg still allows MoQ",
);
assert.match(recipeSrc, /needs a MoQ output/);
assert.match(recipeSrc, /OBS needs a MoQ output/);
assert.match(recipeSrc, /OBS OpenMOQ plugin is draft-16 only/);
assert.match(recipeSrc, /obsMoqSupported/);
assert.doesNotMatch(recipeSrc, /OBS \+ OpenMOQ needs/);
assert.match(recipeSrc, /\["srt", "moq"\]/);

// ---------------------------------------------------------------------------
// Protocol switch must re-default the player.
//
// Regression: benchmark job c49d2ef4 tagged a tile protocol=webrtc but played
// the MediaMTX LL-HLS remux of the WHIP ingest — MediaMTX logged zero WHEP
// reader sessions. isPlaybackModeCompatible whitelists ll-hls for webrtc on a
// MediaMTX host, so the ll-hls a leg inherited while it was SRT/RTMP survived
// the switch to webrtc and defaultPlaybackModeForProtocol("webrtc") was never
// consulted. The UI patches protocol onto the endpoint before coerceRecipe
// runs, so the re-default has to happen at the patch site.
// ---------------------------------------------------------------------------
const PLAYBACK_MODE_ORDER = ["hls", "ll-hls", "dash", "ll-dash", "whep", "moq", "mpegts"];

function defaultPlaybackModeForProtocol(protocol, ingest) {
  if (protocol === "moq") return "moq";
  if (protocol === "webrtc") return "whep";
  if (protocol === "hls") return "mpegts";
  if (ingestRole(ingest) === "mediamtx") return "ll-hls";
  if (ingestRole(ingest) === "zixi") {
    if (!zixiFastHlsAvailable(ingest)) return "mpegts";
    return protocol === "rtmp" ? "mpegts" : "hls";
  }
  if (protocol === "dash") return "hls";
  return "hls";
}

function resolvedPlaybackMode(mode, protocol, ingest) {
  if (mode && isPlaybackModeCompatible(mode, protocol, ingest)) return mode;
  const fallback = defaultPlaybackModeForProtocol(protocol, ingest);
  if (isPlaybackModeCompatible(fallback, protocol, ingest)) return fallback;
  return PLAYBACK_MODE_ORDER.find((id) => isPlaybackModeCompatible(id, protocol, ingest)) ?? "hls";
}

function resolvedSelectablePlaybackMode(mode, protocol, ingest, caps) {
  const resolved = resolvedPlaybackMode(mode, protocol, ingest);
  if (isPlaybackModeCompatible(resolved, protocol, ingest) && playerAllowed(resolved, caps)) {
    return resolved;
  }
  return (
    PLAYBACK_MODE_ORDER.filter(
      (id) => isPlaybackModeCompatible(id, protocol, ingest) && playerAllowed(id, caps),
    )[0] ?? resolved
  );
}

function applyEndpointPatch(endpoint, patch) {
  const next = { ...endpoint, ...patch };
  if (patch.protocol !== undefined && patch.protocol !== endpoint.protocol && !patch.playbackMode) {
    next.playbackMode = undefined;
  }
  return next;
}

/** The playbackMode half of coerceEndpoint. */
function coercePlaybackMode(endpoint, caps, coercedProtocol) {
  const protocol = coercedProtocol ?? endpoint.protocol;
  return resolvedSelectablePlaybackMode(
    protocol === endpoint.protocol ? endpoint.playbackMode : undefined,
    protocol,
    endpoint.ingestEndpointId,
    caps,
  );
}

/** One UI edit: patch the endpoint, then coerce it. */
function editEndpoint(endpoint, patch, caps) {
  const patched = applyEndpointPatch(endpoint, patch);
  return { ...patched, playbackMode: coercePlaybackMode(patched, caps) };
}

for (const ingest of ["gcp_mediamtx", "gcp_east_mediamtx", "linode_mediamtx"]) {
  // ll-hls is the honest SRT/RTMP default on MediaMTX...
  for (const protocol of ["srt", "rtmp"]) {
    assert.equal(
      resolvedSelectablePlaybackMode(undefined, protocol, ingest, CHROME),
      "ll-hls",
      `${protocol}/${ingest} defaults to ll-hls`,
    );
  }
  // ...and must not survive the switch to webrtc.
  for (const from of ["srt", "rtmp"]) {
    const leg = { protocol: from, ingestEndpointId: ingest, playbackMode: "ll-hls" };
    assert.equal(
      editEndpoint(leg, { protocol: "webrtc" }, CHROME).playbackMode,
      "whep",
      `${from}→webrtc on ${ingest} must resolve to whep`,
    );
  }
  // The stale mode is judged "compatible" — that is why a naive merge kept it.
  assert.equal(isPlaybackModeCompatible("ll-hls", "webrtc", ingest), true);
  assert.equal(
    coercePlaybackMode(
      { protocol: "webrtc", ingestEndpointId: ingest, playbackMode: "ll-hls" },
      CHROME,
    ),
    "ll-hls",
    "a settled webrtc leg keeps a deliberate ll-hls choice",
  );
}

// An operator who picks a player in the same edit keeps it.
assert.equal(
  editEndpoint(
    { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
    { protocol: "webrtc", playbackMode: "ll-hls" },
    CHROME,
  ).playbackMode,
  "ll-hls",
  "explicit player in the same patch as the protocol switch wins",
);

// Edits that do not touch the protocol leave a deliberate choice alone.
assert.equal(
  editEndpoint(
    { protocol: "webrtc", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
    { ingestEndpointId: "gcp_east_mediamtx" },
    CHROME,
  ).playbackMode,
  "ll-hls",
  "ingest-only edit keeps the operator's player",
);

assert.equal(
  editEndpoint(
    { protocol: "srt", ingestEndpointId: "gcp_zixi", playbackMode: "hls" },
    { ingestEndpointId: "gcp_east_zixi" },
    CHROME,
  ).playbackMode,
  "mpegts",
  "Central Fast HLS cannot follow the dest to East Edge Compute",
);

// Every protocol switch lands on that protocol's own default.
for (const [from, to, ingest, want] of [
  ["webrtc", "srt", "gcp_mediamtx", "ll-hls"],
  ["webrtc", "rtmp", "gcp_mediamtx", "ll-hls"],
  ["srt", "rtmp", "gcp_zixi", "mpegts"],
  ["rtmp", "srt", "linode_zixi", "mpegts"],
]) {
  const leg = {
    protocol: from,
    ingestEndpointId: ingest,
    playbackMode: resolvedSelectablePlaybackMode(undefined, from, ingest, CHROME),
  };
  assert.equal(
    editEndpoint(leg, { protocol: to }, CHROME).playbackMode,
    want,
    `${from}→${to} on ${ingest}`,
  );
}

// Coercing is idempotent: a settled leg must not oscillate on re-render.
for (const leg of [
  { protocol: "webrtc", ingestEndpointId: "gcp_mediamtx", playbackMode: "whep" },
  { protocol: "srt", ingestEndpointId: "gcp_mediamtx", playbackMode: "ll-hls" },
  { protocol: "moq", ingestEndpointId: "gcp_moq_relay_d18", playbackMode: "moq" },
]) {
  assert.equal(coercePlaybackMode(leg, CHROME), leg.playbackMode, "coerce is idempotent");
}

// Pin the shipped source so the mirror above cannot drift.
assert.match(recipeSrc, /export function applyEndpointPatch/);
assert.match(recipeSrc, /next\.playbackMode = undefined/);
assert.match(recipeSrc, /protocol === endpoint\.protocol \? endpoint\.playbackMode : undefined/);
assert.match(appSrc, /applyEndpointPatch\(endpoint, patch\)/);
assert.doesNotMatch(appSrc, /endpoint\.id === id \? \{ \.\.\.endpoint, \.\.\.patch \}/);
// Operator presets name whep for every webrtc leg (defence in depth).
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "src/operatorRecipe.ts"), "utf8"),
  /protocol: "webrtc",\s*ingestEndpointId: "[^"]+",\s*playbackMode: "(?!whep)/,
);

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
