import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyHlsEndVerdict, hlsPaintedOk } from "./hlsPlayback.ts";

describe("hlsPaintedOk", () => {
  it("rejects a 0s playhead (comparison 30 Linode MTX SRT)", () => {
    assert.equal(hlsPaintedOk({ maxVideoTime: 0 }), false);
    assert.equal(hlsPaintedOk({ maxVideoTime: 0.25 }), false);
    assert.equal(hlsPaintedOk({ maxVideoTime: 0.26 }), true);
  });
});

describe("classifyHlsEndVerdict", () => {
  it("never marks Encode finished after a 404 and zero paint", () => {
    const verdict = classifyHlsEndVerdict({ maxVideoTime: 0 });
    assert.equal(verdict.ok, false);
    assert.notEqual(verdict.status, "Playback OK");
    assert.notEqual(verdict.status, "Encode finished");
    assert.match(verdict.error ?? "", /manifest never loaded/i);
  });

  it("keeps Playback OK after a real playhead", () => {
    const verdict = classifyHlsEndVerdict({ maxVideoTime: 4.2, manifestParsed: true });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, "Playback OK");
  });

  it("does not mark Playback OK after an 18s stall of a 26s encode", () => {
    const verdict = classifyHlsEndVerdict({
      maxVideoTime: 18.757,
      manifestParsed: true,
      encodeDurationSec: 26,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /stalled at 18.8s of a 26s encode/i);
  });
});
