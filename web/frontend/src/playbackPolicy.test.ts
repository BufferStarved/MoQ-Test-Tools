import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PLAYBACK_POLICY,
  dashChasesLiveEdge,
  hlsAllowsLiveJump,
  hlsCompleteLiveSyncSec,
  hlsMaxLiveSyncPlaybackRate,
  isCompletePlayback,
  moqCmafChasesLiveEdge,
  moqLocMaxCatchUpRate,
  mpegTsChasesLiveEdge,
  parsePlaybackPolicy,
  playbackPolicyAppliesToEngine,
  playbackPolicyBanner,
  playbackPolicyToggleVisible,
} from "./playbackPolicy.ts";

describe("playbackPolicy", () => {
  it("defaults to live-edge and parses unknown as live-edge", () => {
    assert.equal(DEFAULT_PLAYBACK_POLICY, "live-edge");
    assert.equal(parsePlaybackPolicy("complete"), "complete");
    assert.equal(parsePlaybackPolicy("nope"), "live-edge");
    assert.equal(isCompletePlayback("complete"), true);
  });

  it("hides the Encode toggle on WebRTC-only recipes", () => {
    assert.equal(playbackPolicyToggleVisible(["webrtc"]), false);
    assert.equal(playbackPolicyToggleVisible(["webrtc", "webrtc"]), false);
    assert.equal(playbackPolicyToggleVisible(["webrtc", "moq"]), true);
    assert.equal(playbackPolicyToggleVisible(["srt", "rtmp"]), true);
    // File / cloud playout / webcam 4-ways still ask live-edge vs complete.
    assert.equal(playbackPolicyToggleVisible(["srt", "moq"]), true);
    assert.equal(playbackPolicyToggleVisible(["rtmp", "srt", "webrtc", "moq"]), true);
  });

  it("does not apply the badge to the WHEP tile", () => {
    assert.equal(playbackPolicyAppliesToEngine("whep"), false);
    assert.equal(playbackPolicyAppliesToEngine("moq"), true);
    assert.equal(playbackPolicyAppliesToEngine("hls"), true);
  });

  it("keeps starve-hold eligible: complete disables chase, not reconnect", () => {
    assert.equal(moqCmafChasesLiveEdge("live-edge"), true);
    assert.equal(moqCmafChasesLiveEdge("complete"), false);
    assert.equal(moqLocMaxCatchUpRate("live-edge", "loc"), 1.25);
    assert.equal(moqLocMaxCatchUpRate("complete", "loc"), 1.0);
    assert.equal(moqLocMaxCatchUpRate("live-edge", "cmaf"), 1.0);
  });

  it("sets HLS complete to 1.0×, larger LL liveSync, no jump", () => {
    assert.equal(hlsCompleteLiveSyncSec(true), 3);
    assert.equal(hlsMaxLiveSyncPlaybackRate("complete", { lowLatency: true }), 1.0);
    assert.equal(hlsMaxLiveSyncPlaybackRate("live-edge", { lowLatency: true }), 1.15);
    assert.equal(hlsMaxLiveSyncPlaybackRate("live-edge", { lowLatency: false, shallow: true }), 1.0);
    assert.equal(hlsAllowsLiveJump("complete"), false);
    assert.equal(hlsAllowsLiveJump("live-edge"), true);
  });

  it("turns MPEG-TS chasing and DASH catch-up off in complete mode", () => {
    assert.equal(mpegTsChasesLiveEdge("complete"), false);
    assert.equal(dashChasesLiveEdge("complete"), false);
    assert.equal(mpegTsChasesLiveEdge("live-edge"), true);
    assert.equal(dashChasesLiveEdge("live-edge"), true);
  });

  it("names the results banner from the persisted policy", () => {
    assert.match(playbackPolicyBanner("complete"), /complete playback/);
    assert.match(playbackPolicyBanner("live-edge"), /live edge/);
  });
});
