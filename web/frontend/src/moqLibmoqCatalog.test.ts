import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMsfCatalog } from "../vendor/moq-playa/packages/msf/dist/catalog-msf00.js";

/**
 * Runtime proof that Vite's published @moqt/msf parser (dist, not src)
 * accepts the catalog libmoq actually ships: string version "1", root
 * initDataList, per-track initRef. 0.5.7+ resolves initRef in the player,
 * not by flattening bytes onto track.initData at parse time.
 */
describe("dist parseMsfCatalog vs libmoq CMAF wire", () => {
  it("keeps version 1 + initRef + catalog.initDataList (no track.initData flatten)", () => {
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
    assert.equal(catalog.version, 1);
    assert.equal(catalog.tracks[0]?.initRef, "vide_1");
    assert.equal(catalog.tracks[1]?.initRef, "soun_2");
    assert.equal(catalog.tracks[0]?.initData, undefined);
    assert.equal(catalog.tracks[1]?.initData, undefined);
    assert.equal(catalog.initDataList?.[0]?.id, "vide_1");
    assert.equal(catalog.initDataList?.[0]?.data, videoInit);
    assert.equal(catalog.initDataList?.[1]?.id, "soun_2");
    assert.equal(catalog.initDataList?.[1]?.data, audioInit);
    assert.ok((catalog.initDataList?.[0]?.data ?? "").length > 0);
  });
});
