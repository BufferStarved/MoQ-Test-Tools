/** Convert WebCodecs AVC (length-prefixed / avcC) chunks to Annex-B for ffmpeg. */

const START = new Uint8Array([0, 0, 0, 1]);

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function nal(payload: Uint8Array): Uint8Array {
  return concat([START, payload]);
}

/** Pull SPS/PPS NAL units from an AVCDecoderConfigurationRecord (avcC). */
export function avcCParameterSetsToAnnexB(avcC: Uint8Array): Uint8Array {
  if (avcC.byteLength < 7 || avcC[0] !== 1) {
    return new Uint8Array(0);
  }
  const view = new DataView(avcC.buffer, avcC.byteOffset, avcC.byteLength);
  const parts: Uint8Array[] = [];
  let offset = 5;
  const numSps = avcC[offset] & 0x1f;
  offset += 1;
  for (let i = 0; i < numSps; i += 1) {
    if (offset + 2 > avcC.byteLength) {
      break;
    }
    const length = view.getUint16(offset);
    offset += 2;
    if (offset + length > avcC.byteLength) {
      break;
    }
    parts.push(nal(avcC.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset >= avcC.byteLength) {
    return concat(parts);
  }
  const numPps = avcC[offset];
  offset += 1;
  for (let i = 0; i < numPps; i += 1) {
    if (offset + 2 > avcC.byteLength) {
      break;
    }
    const length = view.getUint16(offset);
    offset += 2;
    if (offset + length > avcC.byteLength) {
      break;
    }
    parts.push(nal(avcC.subarray(offset, offset + length)));
    offset += length;
  }
  return concat(parts);
}

/** Length-prefixed access unit → Annex-B (4-byte big-endian lengths). */
export function lengthPrefixedToAnnexB(payload: Uint8Array): Uint8Array {
  if (payload.byteLength >= 4 && payload[0] === 0 && payload[1] === 0) {
    // Already Annex-B (00 00 00 01 or 00 00 01).
    if (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1)) {
      return payload;
    }
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= payload.byteLength) {
    const length = view.getUint32(offset);
    offset += 4;
    if (length <= 0 || offset + length > payload.byteLength) {
      break;
    }
    parts.push(nal(payload.subarray(offset, offset + length)));
    offset += length;
  }
  return concat(parts);
}

export interface H264AnnexBMuxer {
  push: (data: Uint8Array, description?: Uint8Array) => void;
  toBlob: () => Blob;
  byteLength: () => number;
}

export function createH264AnnexBMuxer(): H264AnnexBMuxer {
  const parts: Uint8Array[] = [];
  let insertedParameterSets = false;
  let bytes = 0;

  return {
    push(data: Uint8Array, description?: Uint8Array) {
      if (description && !insertedParameterSets) {
        const sets = avcCParameterSetsToAnnexB(description);
        if (sets.byteLength > 0) {
          parts.push(sets);
          bytes += sets.byteLength;
          insertedParameterSets = true;
        }
      }
      const annexB = lengthPrefixedToAnnexB(data);
      if (annexB.byteLength === 0) {
        return;
      }
      parts.push(annexB);
      bytes += annexB.byteLength;
    },
    toBlob() {
      const bytes = concat(parts);
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      return new Blob([copy], { type: "video/h264" });
    },
    byteLength() {
      return bytes;
    },
  };
}
