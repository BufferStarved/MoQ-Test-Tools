import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMsfCatalog } from "../vendor/moq-playa/packages/msf/dist/catalog-msf00.js";

/**
 * Runtime proof that Vite's published @moqt/msf parser (dist, not src)
 * flattens the catalog libmoq actually ships. Source-only patches left
 * headed playa waiting 10s for an in-band ftyp+moov ffmpeg never sends.
 */
describe("dist parseMsfCatalog vs libmoq CMAF wire", () => {
  it("turns initDataList + initRef into track.initData", () => {
    const videoInit = btoa("ftyp-moov-video");
    const audioInit = btoa("ftyp-moov-audio");
    const catalog = parseMsfCatalog(
      JSON.stringify({
        version: "1",
        tracks: [
          {
            name: "vide_1",
            packaging: "cmaf",
            isLive: true,
            role: "video",
            codec: "avc1.4d4028",
            initRef: "vide_1",
          },
          {
            name: "soun_2",
            packaging: "cmaf",
            isLive: true,
            role: "audio",
            codec: "mp4a.40.2",
            samplerate: 48000,
            channelConfig: "2",
            initRef: "soun_2",
          },
        ],
        initDataList: [
          { id: "vide_1", type: "inline", data: videoInit },
          { id: "soun_2", type: "inline", data: audioInit },
        ],
      }),
    );
    assert.equal(catalog.tracks[0]?.initData, videoInit);
    assert.equal(catalog.tracks[1]?.initData, audioInit);
    assert.ok(catalog.tracks[0]!.initData!.length > 0);
  });
});
