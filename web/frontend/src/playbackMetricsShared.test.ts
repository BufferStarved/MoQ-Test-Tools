import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPlaybackHighWater,
  mergeEncoderSampleWithLivePlayback,
  mergePlaybackSampleIntoUploadSample,
  overlayPlaybackOnLatestSample,
} from "./playbackMetricsShared.ts";

describe("applyPlaybackHighWater", () => {
  it("lets a lower post-seek e2e replace a higher pre-seek e2e", () => {
    const merged = applyPlaybackHighWater(
      { e2e_latency_ms: 2200, playback_buffer_sec: 2, go_live_e2e_ms: 8800 },
      { e2e_latency_ms: 8800, playback_buffer_sec: 8, go_live_e2e_ms: 8800 },
    );
    assert.equal(merged.e2e_latency_ms, 2200);
    assert.equal(merged.playback_buffer_sec, 2);
    assert.equal(merged.go_live_e2e_ms, 8800);
  });

  it("does not let a reconnect zero erase painted-glass gauges", () => {
    const merged = applyPlaybackHighWater(
      { e2e_latency_ms: 0, playback_buffer_sec: 0, playback_frames_rendered: 0 },
      { e2e_latency_ms: 2200, playback_buffer_sec: 2, playback_frames_rendered: 90 },
    );
    assert.equal(merged.e2e_latency_ms, 2200);
    assert.equal(merged.playback_buffer_sec, 2);
    assert.equal(merged.playback_frames_rendered, 90);
  });

  it("keeps the pre-click go_live latch when live e2e drops", () => {
    const merged = applyPlaybackHighWater(
      { e2e_latency_ms: 400, go_live_e2e_ms: 0, go_live_at_sec: 0 },
      { e2e_latency_ms: 8800, go_live_e2e_ms: 8800, go_live_at_sec: 12 },
    );
    assert.equal(merged.e2e_latency_ms, 400);
    assert.equal(merged.go_live_e2e_ms, 8800);
    assert.equal(merged.go_live_at_sec, 12);
  });
});

describe("overlayPlaybackOnLatestSample", () => {
  it("writes HUD latestSample on every playback tick, not only encoder SSE", () => {
    const latest = overlayPlaybackOnLatestSample(
      {
        elapsed_sec: 20,
        encoded_bitrate_kbps: 2500,
        e2e_latency_ms: 8800,
        playback_buffer_sec: 8,
        go_live_e2e_ms: 8800,
      },
      {
        elapsed_sec: 21,
        e2e_latency_ms: 2200,
        playback_buffer_sec: 2,
        go_live_e2e_ms: 8800,
        playback_stats_events: 1,
        playback_stall_count: 0,
        playback_frames_rendered: 600,
        playback_frames_dropped: 0,
        playback_bitrate_bps: 0,
        playback_ttff_ms: 800,
        playback_hls_errors: 0,
        playback_hls_fatal_errors: 0,
        playback_hls_buffer_stalls: 0,
        playback_hls_frag_loads: 0,
        playback_video_time_sec: 18,
        playback_rebuffer_sec: 0,
        playback_error_count: 0,
        go_live_at_sec: 20,
      },
    );
    assert.equal(latest.e2e_latency_ms, 2200);
    assert.equal(latest.playback_buffer_sec, 2);
    assert.equal(latest.go_live_e2e_ms, 8800);
    assert.equal(latest.encoded_bitrate_kbps, 2500);
  });
});

describe("mergeEncoderSampleWithLivePlayback", () => {
  it("does not restore a stale pre-seek e2e from the encoder SSE overlay", () => {
    const merged = mergeEncoderSampleWithLivePlayback(
      { elapsed_sec: 22, encoded_bitrate_kbps: 2600, e2e_latency_ms: 8800, playback_buffer_sec: 8 },
      { elapsed_sec: 21, e2e_latency_ms: 2200, playback_buffer_sec: 2, go_live_e2e_ms: 8800 },
    );
    assert.equal(merged.e2e_latency_ms, 2200);
    assert.equal(merged.playback_buffer_sec, 2);
    assert.equal(merged.encoded_bitrate_kbps, 2600);
  });
});

describe("mergePlaybackSampleIntoUploadSample", () => {
  it("replaces a higher pre-seek e2e on the matching encoder row", () => {
    const samples = mergePlaybackSampleIntoUploadSample(
      [
        { elapsed_sec: 19, e2e_latency_ms: 8700, playback_buffer_sec: 7.8 },
        { elapsed_sec: 20, e2e_latency_ms: 8800, playback_buffer_sec: 8 },
      ],
      {
        elapsed_sec: 20,
        e2e_latency_ms: 2200,
        playback_buffer_sec: 2,
        go_live_e2e_ms: 8800,
        playback_stats_events: 1,
        playback_stall_count: 0,
        playback_frames_rendered: 600,
        playback_frames_dropped: 0,
        playback_bitrate_bps: 0,
        playback_ttff_ms: 800,
        playback_hls_errors: 0,
        playback_hls_fatal_errors: 0,
        playback_hls_buffer_stalls: 0,
        playback_hls_frag_loads: 0,
        playback_video_time_sec: 18,
        playback_rebuffer_sec: 0,
        playback_error_count: 0,
        go_live_at_sec: 20,
      },
    );
    assert.equal(samples[1].e2e_latency_ms, 2200);
    assert.equal(samples[1].playback_buffer_sec, 2);
    assert.equal(samples[0].e2e_latency_ms, 8700);
  });
});
