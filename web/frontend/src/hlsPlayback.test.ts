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

  it("marks Playback OK when the operator Stops after paint", () => {
    const verdict = classifyHlsEndVerdict({
      maxVideoTime: 21.2,
      manifestParsed: true,
      encodeDurationSec: 81,
      encodeElapsedSec: 71,
      runStopped: true,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, "Playback OK");
    assert.equal(verdict.error, null);
  });

  it("returns Playback OK after operator stop even when the playhead lagged", () => {
    const verdict = classifyHlsEndVerdict({
      maxVideoTime: 32.2,
      lastError:
        "HLS manifest never loaded — origin 404 or unreachable. Encode-only is not playback.",
      encodeDurationSec: 50,
      encodeElapsedSec: 50,
      runStopped: true,
      jobStatus: "completed",
      benchmarkLoading: false,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
  });

  it("returns Playback OK when the encode completed and the comparison is idle", () => {
    const verdict = classifyHlsEndVerdict({
      maxVideoTime: 32.2,
      encodeDurationSec: 50,
      encodeElapsedSec: 50,
      jobStatus: "completed",
      benchmarkLoading: false,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
  });
});
