import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BROWSER_LOC_AUDIO_TRACK,
  BROWSER_LOC_VIDEO_CODEC,
  BROWSER_LOC_VIDEO_TRACK,
  browserLocCatalogTracks,
  browserLocKnownTracks,
} from "./locCatalog.ts";

describe("browserLocKnownTracks", () => {
  it("names the live LOC video track video, not vide_1", () => {
    const known = browserLocKnownTracks({ includeAudio: false });
    assert.equal(known.video.name, BROWSER_LOC_VIDEO_TRACK);
    assert.equal(known.video.name, "video");
    assert.equal(known.video.codec, BROWSER_LOC_VIDEO_CODEC);
    assert.equal("audio" in known, false);
  });

  it("adds audio only when the publisher is sending it", () => {
    const known = browserLocKnownTracks({ includeAudio: true });
    assert.equal(known.audio?.name, BROWSER_LOC_AUDIO_TRACK);
  });
});

describe("browserLocCatalogTracks", () => {
  it("advertises packaging loc so playa does not open MSE", () => {
    const catalog = browserLocCatalogTracks({ includeAudio: false, videoCodec: "avc1.640028" });
    assert.equal(catalog.tracks[0]?.name, "video");
    assert.equal(catalog.tracks[0]?.packaging, "loc");
    assert.equal(catalog.tracks[0]?.codec, "avc1.640028");
  });
});
