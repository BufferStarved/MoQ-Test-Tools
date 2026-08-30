import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  avcChunkIsSyncPoint,
  buildAvcC,
  collectAvcNals,
  isAvcCRecord,
  normalizeLocVideoAccessUnit,
} from "./h264AnnexB.ts";

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

describe("normalizeLocVideoAccessUnit", () => {
  const sps = new Uint8Array([0x67, 0x4d, 0x40, 0x28, 0x9a]);
  const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  const idr = new Uint8Array([0x65, 0x88, 0x84, 0xff]);

  it("builds avcC and prepends SPS/PPS onto an avcC IDR (b2969493)", () => {
    const avcC = buildAvcC(sps, pps);
    assert.equal(isAvcCRecord(avcC), true);
    const normalized = normalizeLocVideoAccessUnit(avcc([idr]), avcC);
    assert.ok(normalized.description);
    assert.equal(isAvcCRecord(normalized.description), true);
    const nals = collectAvcNals(normalized.data);
    assert.equal((nals[0]?.[0] ?? 0) & 0x1f, 7);
    assert.equal((nals[1]?.[0] ?? 0) & 0x1f, 8);
    assert.equal((nals[2]?.[0] ?? 0) & 0x1f, 5);
    assert.deepEqual([...normalized.data.subarray(0, 4)], [0, 0, 0, 1]);
  });

  it("synthesizes avcC from in-band Annex-B SPS/PPS when description is missing", () => {
    const annexb = new Uint8Array([
      0, 0, 0, 1, ...sps,
      0, 0, 0, 1, ...pps,
      0, 0, 0, 1, ...idr,
    ]);
    const normalized = normalizeLocVideoAccessUnit(annexb, undefined);
    assert.ok(normalized.description);
    assert.equal(normalized.description[1], 0x4d);
    assert.equal(normalized.description[3], 0x28);
    assert.deepEqual([...normalized.data.subarray(0, 4)], [0, 0, 0, 1]);
  });

  it("does not duplicate SPS already in the access unit", () => {
    const avcC = buildAvcC(sps, pps);
    const normalized = normalizeLocVideoAccessUnit(avcc([sps, pps, idr]), avcC);
    const types = collectAvcNals(normalized.data).map((unit) => (unit[0] ?? 0) & 0x1f);
    assert.deepEqual(types, [7, 8, 5]);
  });
});
