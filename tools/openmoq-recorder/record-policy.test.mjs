import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CATALOG_TRACK,
  catalogInitB64,
  isAliasReuseError,
  isRetryableSubscribeError,
  nextTrackForReconnect,
  orderedTrackNames,
  parseCatalogObject,
  reconnectBackoffMs,
  shouldResubscribeAfterSilence,
  shouldRetrySubscribeOnSameSession,
  subscribeFilterForTrack,
  wantsCatalogSubscribe,
} from "./record-policy.mjs";

describe("openmoq recorder §11.1 policy", () => {
  it("uses AbsoluteStart for catalog and CMAF so one-shot objects are retrievable", () => {
    assert.equal(subscribeFilterForTrack("catalog").type, "AbsoluteStart");
    assert.equal(subscribeFilterForTrack("vide_1").type, "AbsoluteStart");
    assert.equal(subscribeFilterForTrack("vide_1").startGroup, 0n);
    assert.equal(subscribeFilterForTrack("video").type, "LargestObject");
  });

  it("tries vide_1 before LOC video so a missing video track does not consume an alias", () => {
    assert.deepEqual(orderedTrackNames(["video", "vide_1"]), ["vide_1", "video"]);
    assert.equal(wantsCatalogSubscribe(["vide_1"]), true);
    assert.equal(wantsCatalogSubscribe(["video"]), false);
  });

  it("never retries SUBSCRIBE on the same session after 0x10 or alias reuse", () => {
    const miss = new Error("Subscribe failed: no such namespace or track (0x10)");
    const reuse = new Error(
      "track alias 1 is still guarded by a terminating prior subscription (§11.1) — reuse refused",
    );
    assert.equal(isRetryableSubscribeError(miss), true);
    assert.equal(isAliasReuseError(reuse), true);
    assert.equal(shouldRetrySubscribeOnSameSession(miss), false);
    assert.equal(shouldRetrySubscribeOnSameSession(reuse), false);
    assert.equal(shouldResubscribeAfterSilence(), false);
  });

  it("keeps vide_1 after a namespace miss and rotates only on unknown track", () => {
    const tracks = ["video", "vide_1"];
    assert.equal(
      nextTrackForReconnect(tracks, "vide_1", new Error("no such namespace")),
      "vide_1",
    );
    assert.equal(
      nextTrackForReconnect(tracks, "vide_1", new Error("Unknown track: vide_1")),
      "video",
    );
    assert.ok(reconnectBackoffMs(0) >= 400);
    assert.ok(reconnectBackoffMs(8) <= 2000);
  });

  it("reads CMAF init from initDataList + initRef, not a fake LOC catalog", () => {
    const videoInit = Buffer.from("ftyp-moov-video").toString("base64");
    const catalog = parseCatalogObject(JSON.stringify({
      version: "1",
      tracks: [{ name: "vide_1", packaging: "cmaf", initRef: "vide_1" }],
      initDataList: [{ id: "vide_1", type: "inline", data: videoInit }],
    }));
    assert.equal(catalogInitB64(catalog, "vide_1"), videoInit);
    assert.equal(catalogInitB64({ tracks: [] }, "vide_1"), "");
    assert.equal(CATALOG_TRACK, "catalog");
  });
});
