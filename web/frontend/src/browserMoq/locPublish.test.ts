import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeLocHeaders, parseLocHeaders, toVideoChunkInit } from "@moqt/loc";
import {
  avcChunkHasIdr,
  buildAvcC,
  collectAvcNals,
  locVideoSampleAgreesWithAvcC,
  normalizeLocVideoAccessUnit,
} from "./h264AnnexB.ts";
import {
  browserLocHeaderOptions,
  locReplayCaptureTimestampUs,
  locVideoObjectInit,
  nextLocPublishTimestampUs,
} from "./locCatalog.ts";

function avcc(nals: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const nal of nals) {
    parts.push(
      (nal.byteLength >>> 24) & 0xff,
      (nal.byteLength >>> 16) & 0xff,
      (nal.byteLength >>> 8) & 0xff,
      nal.byteLength & 0xff,
    );
    parts.push(...nal);
  }
  return new Uint8Array(parts);
}

describe("publisher object vs playa VideoDecoder", () => {
  const sps = new Uint8Array([0x67, 0x4d, 0x40, 0x28, 0x9a]);
  const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  const idr = new Uint8Array([0x65, 0x88, 0x84, 0xff]);
  const pFrame = new Uint8Array([0x41, 0x9a, 0x00]);

  it("avc1 + VideoConfig is avcC, payload is IDR-only AVCC, PTS stays encoder (89cf102)", () => {
    const annexb = new Uint8Array([
      0, 0, 0, 1, ...sps,
      0, 0, 0, 1, ...pps,
      0, 0, 0, 1, ...idr,
    ]);
    const normalized = normalizeLocVideoAccessUnit(annexb, undefined);
    assert.equal(locVideoSampleAgreesWithAvcC(normalized.data, normalized.description).ok, true);
    assert.equal(avcChunkHasIdr(normalized.data), true);
    assert.deepEqual(
      collectAvcNals(normalized.data).map((unit) => (unit[0] ?? 0) & 0x1f),
      [5],
    );

    const captureUs = 66_666;
    const headers = locVideoObjectInit({
      captureTimestampUs: captureUs,
      isKeyframe: avcChunkHasIdr(normalized.data),
      description: normalized.description,
    });
    assert.equal(headers.videoFrameMarking.independent, true);
    assert.ok(headers.videoConfig);
    assert.equal(headers.videoConfig[0], 1);
    assert.equal(headers.videoConfig[4]! & 0x03, 3);

    const wire = encodeLocHeaders(headers, browserLocHeaderOptions(18));
    assert.ok(wire);
    const parsed = parseLocHeaders(wire, browserLocHeaderOptions(18));
    const chunk = toVideoChunkInit(normalized.data, parsed);
    assert.equal(chunk.type, "key");
    assert.equal(chunk.timestamp, captureUs);
    assert.equal(parsed.videoFrameMarking?.independent, true);
    assert.ok(parsed.videoConfig && parsed.videoConfig.byteLength === headers.videoConfig.byteLength);

    const replayTs = locReplayCaptureTimestampUs(captureUs);
    assert.equal(replayTs, captureUs);
    assert.ok(replayTs < Date.now() * 100);
    const liveTs = nextLocPublishTimestampUs(99_999, replayTs);
    assert.ok(liveTs > replayTs);
  });

  it("does not mark a hardware type=key P-frame as independent after avcC strip", () => {
    const avcC = buildAvcC(sps, pps);
    const normalized = normalizeLocVideoAccessUnit(avcc([sps, pps, pFrame]), avcC);
    assert.equal(avcChunkHasIdr(normalized.data), false);
    const headers = locVideoObjectInit({
      captureTimestampUs: 33_333,
      isKeyframe: avcChunkHasIdr(normalized.data),
      description: normalized.description,
    });
    assert.equal(headers.videoFrameMarking.independent, false);
    const chunk = toVideoChunkInit(normalized.data, headers);
    assert.equal(chunk.type, "delta");
  });
});
