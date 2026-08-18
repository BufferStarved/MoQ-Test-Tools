/**
 * HTTPS pages must proxy WHIP/WHEP SDP to http://host:8889.
 * Mirrors web/frontend/src/webrtcSignaling.ts.
 */
import assert from "node:assert/strict";

function proxiedWebrtcSignalingUrl(target, loc) {
  const trimmed = target.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed, loc.href);
    if (parsed.protocol === "http:" && loc.isSecureContext) {
      return `/api/webrtc/sdp?url=${encodeURIComponent(parsed.href)}`;
    }
    return parsed.href;
  } catch {
    return trimmed;
  }
}

const httpsPage = { href: "https://moq.sean-mccarthy.net/", isSecureContext: true };
const httpPage = { href: "http://127.0.0.1:5173/", isSecureContext: false };

assert.equal(
  proxiedWebrtcSignalingUrl("http://34.9.217.178:8889/stream/whep", httpsPage),
  `/api/webrtc/sdp?url=${encodeURIComponent("http://34.9.217.178:8889/stream/whep")}`,
);
assert.equal(
  proxiedWebrtcSignalingUrl("https://relay.example/whep", httpsPage),
  "https://relay.example/whep",
);
assert.equal(
  proxiedWebrtcSignalingUrl("http://35.196.97.22:8889/whip/whep", httpPage),
  "http://35.196.97.22:8889/whip/whep",
);
assert.equal(proxiedWebrtcSignalingUrl("  ", httpsPage), "");

console.log("unit-webrtc-signaling: PASS");
