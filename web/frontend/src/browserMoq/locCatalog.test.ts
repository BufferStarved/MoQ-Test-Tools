import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BROWSER_LOC_AUDIO_TRACK,
  BROWSER_LOC_CATALOG_GROUP,
  BROWSER_LOC_CATALOG_TRACK,
  BROWSER_LOC_VIDEO_CODEC,
  BROWSER_LOC_VIDEO_TRACK,
  browserLocCatalogTracks,
  browserLocHeaderOptions,
  browserLocKnownTracks,
  browserLocPublishTrackNames,
  isPublishAccepted,
  locCatalogTrackShouldEnd,
  locKeyframeVideoConfig,
} from "./locCatalog.ts";

describe("browserLocKnownTracks", () => {
  it("names the live LOC video track video, not vide_1 or CMAF vide_1", () => {
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

describe("browserLocHeaderOptions", () => {
  it("selects d18 vi64 so draft-18 playa can parse CaptureTimestamp", () => {
    assert.deepEqual(browserLocHeaderOptions(18), { wireProfile: "d18-delta-vi64" });
    assert.deepEqual(browserLocHeaderOptions(16), { wireProfile: "d16-delta-varint" });
  });
});

describe("browserLocPublishTrackNames", () => {
  it("live-writes catalog then video so FETCH is not empty", () => {
    assert.deepEqual(browserLocPublishTrackNames({ includeAudio: false }), [
      BROWSER_LOC_CATALOG_TRACK,
      BROWSER_LOC_VIDEO_TRACK,
    ]);
    assert.equal(BROWSER_LOC_CATALOG_TRACK, "catalog");
    assert.equal(BROWSER_LOC_CATALOG_GROUP, 0n);
  });

  it("adds audio only when the publisher is sending it", () => {
    assert.deepEqual(browserLocPublishTrackNames({ includeAudio: true }), [
      "catalog",
      "video",
      BROWSER_LOC_AUDIO_TRACK,
    ]);
  });
});

describe("locCatalogTrackShouldEnd", () => {
  it("keeps the catalog track live for Joining FETCH", () => {
    assert.equal(locCatalogTrackShouldEnd(), false);
  });
});

describe("isPublishAccepted", () => {
  it("matches REQUEST_OK for this publish request id", () => {
    assert.equal(isPublishAccepted({ type: "REQUEST_OK", requestId: 7n }, 7n), true);
    assert.equal(isPublishAccepted({ type: "PUBLISH_OK", requestId: 7n }, 7n), true);
    assert.equal(isPublishAccepted({ type: "REQUEST_OK", requestId: 8n }, 7n), false);
    assert.equal(isPublishAccepted({ type: "SUBSCRIBE", requestId: 7n }, 7n), false);
    assert.equal(isPublishAccepted(null, 7n), false);
  });
});

describe("locKeyframeVideoConfig", () => {
  it("prefers the chunk description, then the last avcC", () => {
    const fresh = new Uint8Array([1, 2, 3]);
    const last = new Uint8Array([4, 5]);
    assert.equal(locKeyframeVideoConfig(fresh, last), fresh);
    assert.equal(locKeyframeVideoConfig(undefined, last), last);
    assert.equal(locKeyframeVideoConfig(new Uint8Array(), last), last);
    assert.equal(locKeyframeVideoConfig(undefined, undefined), undefined);
  });
});
