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
  locCatalogFetchEndLocation,
  locCatalogFetchShouldServe,
  locCatalogLargestLocation,
  locCatalogSubscribeParameters,
  locCatalogTrackShouldEnd,
  locKeyframeVideoConfig,
  locIdrReplayGroup,
  locNextMediaGroup,
  locSubscriberLargestLocation,
  locVideoFetchEndLocation,
  locVideoFetchShouldServe,
  locVideoSubscribeParameters,
  resolvePublishOkWaiter,
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

  it("does not inject initData or initRef (9958d69 — FETCH the live catalog)", () => {
    const catalog = browserLocCatalogTracks({ includeAudio: true });
    for (const track of catalog.tracks) {
      assert.equal("initData" in track, false);
      assert.equal("initRef" in track, false);
    }
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
    assert.equal(isPublishAccepted({ type: "REQUEST_OK" }, 7n), true);
    assert.equal(isPublishAccepted({ type: "REQUEST_OK", requestId: 8n }, 7n), false);
    assert.equal(isPublishAccepted({ type: "SUBSCRIBE", requestId: 7n }, 7n), false);
    assert.equal(isPublishAccepted(null, 7n), false);
  });
});

describe("resolvePublishOkWaiter", () => {
  it("uses a stamped requestId and does not steal a different waiter", () => {
    const waiters = new Map<bigint, string>([
      [7n, "ns"],
      [9n, "catalog"],
    ]);
    assert.deepEqual(resolvePublishOkWaiter(9n, waiters), { requestId: 9n, waiter: "catalog" });
    assert.equal(resolvePublishOkWaiter(8n, waiters), undefined);
  });

  it("takes the oldest waiter when draft-18 omits requestId", () => {
    const waiters = new Map<bigint, string>([[7n, "ns"]]);
    assert.deepEqual(resolvePublishOkWaiter(undefined, waiters), { requestId: 7n, waiter: "ns" });
    assert.equal(resolvePublishOkWaiter(undefined, new Map()), undefined);
  });
});

describe("locCatalogFetch range", () => {
  it("advertises exclusive one-past so FETCH_OK is not an empty range", () => {
    assert.deepEqual(locCatalogLargestLocation(), { group: 0n, object: 0n });
    assert.deepEqual(locCatalogFetchEndLocation(), { group: 0n, object: 1n });
    assert.notDeepEqual(locCatalogFetchEndLocation(), locCatalogLargestLocation());
    const params = locCatalogSubscribeParameters();
    assert.equal(params.parameters.size, 1);
  });
});

describe("locCatalogFetchShouldServe", () => {
  it("serves standalone FETCH for the catalog track", () => {
    assert.equal(locCatalogFetchShouldServe({ trackName: "catalog" }), true);
    assert.equal(locCatalogFetchShouldServe({ trackName: "video" }), false);
  });

  it("serves Joining FETCH on the catalog SUBSCRIBE", () => {
    assert.equal(
      locCatalogFetchShouldServe({
        joiningRequestId: 3n,
        catalogSubscribeIds: new Set([3n]),
      }),
      true,
    );
    assert.equal(
      locCatalogFetchShouldServe({
        joiningRequestId: 3n,
        catalogSubscribeIds: new Set([4n]),
      }),
      false,
    );
  });

  it("serves a Joining FETCH that races the forwarded catalog SUBSCRIBE", () => {
    assert.equal(
      locCatalogFetchShouldServe({
        joiningRequestId: 3n,
        catalogSubscribeIds: new Set(),
        liveCatalogWritten: true,
      }),
      true,
    );
    assert.equal(
      locCatalogFetchShouldServe({
        joiningRequestId: 3n,
        catalogSubscribeIds: new Set(),
        liveCatalogWritten: false,
      }),
      false,
    );
  });

  it("does not serve a video Joining FETCH as catalog JSON", () => {
    assert.equal(
      locCatalogFetchShouldServe({
        trackName: "video",
        joiningRequestId: 3n,
        liveCatalogWritten: true,
      }),
      false,
    );
    assert.equal(
      locCatalogFetchShouldServe({
        joiningRequestId: 9n,
        catalogSubscribeIds: new Set(),
        mediaSubscribeIds: new Set([9n]),
        liveCatalogWritten: true,
      }),
      false,
    );
  });
});

describe("locVideoFetchShouldServe", () => {
  it("serves standalone and joining video FETCH as video, not catalog", () => {
    assert.equal(locVideoFetchShouldServe({ trackName: "video" }), true);
    assert.equal(
      locVideoFetchShouldServe({
        joiningRequestId: 9n,
        mediaSubscribeIds: new Set([9n]),
      }),
      true,
    );
    assert.equal(locVideoFetchShouldServe({ trackName: "catalog" }), false);
    assert.deepEqual(locVideoFetchEndLocation(4n), { group: 4n, object: 1n });
  });
});

describe("locSubscriberLargestLocation", () => {
  it("does not advertise a phantom {group, 0} before this alias has sent", () => {
    assert.equal(locSubscriberLargestLocation(1_756_543_139_000n, 0n), null);
    assert.deepEqual(locSubscriberLargestLocation(3n, 2n), { group: 3n, object: 1n });
    assert.equal(locVideoSubscribeParameters(null).parameters, undefined);
    assert.equal(locVideoSubscribeParameters({ group: 3n, object: 1n }).parameters?.size, 1);
  });
});

describe("locNextMediaGroup", () => {
  it("starts at 0 so GOP ids stay inside uint32", () => {
    assert.equal(locNextMediaGroup(0n, false), 0n);
    assert.equal(locNextMediaGroup(0n, true), 1n);
    assert.equal(locNextMediaGroup(4n, true), 5n);
    assert.ok(locNextMediaGroup(0n, false) < 0xffffffffn);
  });
});

describe("locIdrReplayGroup", () => {
  it("replays the advertised GOP, not the next one (9e0a507e)", () => {
    assert.equal(locIdrReplayGroup(5n), 5n);
    assert.equal(locIdrReplayGroup(0n), 0n);
    assert.notEqual(locIdrReplayGroup(5n), locNextMediaGroup(5n, true));
    const advertised = locVideoSubscribeParameters({ group: 5n, object: 0n });
    assert.equal(advertised.parameters?.size, 1);
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

  it("still returns last avcC for a delta so mid-GOP join can configure (0ea3b335)", () => {
    const last = new Uint8Array([1, 0x4d, 0x40, 0x28, 0xff, 0xe1]);
    assert.equal(locKeyframeVideoConfig(undefined, last), last);
  });
});
