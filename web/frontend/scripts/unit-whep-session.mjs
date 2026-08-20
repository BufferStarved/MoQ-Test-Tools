/**
 * WHEP must POST SDP through the HTTPS proxy, strip trickle, and retry 404s.
 * Mirrors web/frontend/src/whepSession.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/whepSession.ts"),
  "utf8",
);

assert.match(src, /proxiedWebrtcSignalingUrl/);
assert.match(src, /unwrapFastApiDetail/);
assert.match(src, /waitForWhepIceTerminal/);
assert.match(src, /WHEP_ICE_DISCONNECT_GRACE_MS/);
assert.match(src, /whepIceWaitDecision/);
assert.match(src, /"grace"/);
assert.doesNotMatch(
  src,
  /const terminal = \(state: RTCIceConnectionState\) =>\s*state === "failed" \|\| state === "disconnected"/,
);
assert.match(src, /"Content-Type": "application\/sdp"/);
assert.doesNotMatch(src, /method: "POST",\s*const headers/);
assert.match(src, /a=ice-options:trickle/);
assert.match(src, /status === 404/);
assert.match(src, /Reuse one gathered offer/);
assert.match(src, /UDP 8189/);
assert.match(src, /addTransceiver\("video"/);
assert.match(src, /status === 406/);
assert.match(src, /event\.streams\[0\]/);
assert.match(src, /waitForWhepMedia/);
assert.match(src, /videoWidth >= 16/);
assert.doesNotMatch(src, /const fallback = new MediaStream\(\);\s*video\.srcObject = fallback;/);

console.log("unit-whep-session: PASS");
