import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avcChunkIsSyncPoint } from "./h264AnnexB.ts";

function avcc(nals: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const nal of nals) {
    parts.push((nal.byteLength >>> 24) & 0xff, (nal.byteLength >>> 16) & 0xff, (nal.byteLength >>> 8) & 0xff, nal.byteLength & 0xff);
    parts.push(...nal);
  }
  return new Uint8Array(parts);
}

describe("avcChunkIsSyncPoint", () => {
  it("detects a length-prefixed IDR (NAL type 5)", () => {
    assert.equal(avcChunkIsSyncPoint(avcc([new Uint8Array([0x65, 0x88, 0x84])])), true);
  });

  it("detects SPS (NAL type 7) as a sync point", () => {
    assert.equal(avcChunkIsSyncPoint(avcc([new Uint8Array([0x67, 0x42, 0xc0])])), true);
  });

  it("rejects a non-IDR slice (NAL type 1)", () => {
    assert.equal(avcChunkIsSyncPoint(avcc([new Uint8Array([0x41, 0x9a, 0x00])])), false);
  });

  it("skips SEI/PPS/AUD then accepts the IDR", () => {
    assert.equal(
      avcChunkIsSyncPoint(
        avcc([
          new Uint8Array([0x06, 0x00]),
          new Uint8Array([0x68, 0xce]),
          new Uint8Array([0x65, 0x88]),
        ]),
      ),
      true,
    );
  });

  it("detects Annex-B IDR start codes", () => {
    assert.equal(avcChunkIsSyncPoint(new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84])), true);
    assert.equal(avcChunkIsSyncPoint(new Uint8Array([0, 0, 1, 0x41, 0x9a])), false);
  });

  it("does not treat a short AVCC length prefix as Annex-B", () => {
    // length=3 → 00 00 00 03 … looks like a start-code attempt if misread
    assert.equal(avcChunkIsSyncPoint(avcc([new Uint8Array([0x65, 0x00, 0x00])])), true);
  });
});
