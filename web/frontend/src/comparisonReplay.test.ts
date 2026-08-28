import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  moqWatchdogFailsWhileEncodeRunning,
  moqxNeverAnnounced,
  uniquePublishSeriesCount,
  visibleLeg,
  visibleMoqError,
  type ComparisonLastRow,
} from "./comparisonReplay.ts";

/** Last sample per series from comparison (29).csv — 4 dests, 6 exported rows. */
const COMPARISON_29: ComparisonLastRow[] = [
  {
    stream: "Stream 1 (MoQ)",
    protocol: "moq",
    endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
    encode_frames_total: 1122,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 2 (SRT)",
    protocol: "srt",
    endpoint: "srt://35.222.33.58:10080?mode=caller&latency=2000000&streamid=#!::r=SRT",
    encode_frames_total: 1166,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 3 (WebRTC)",
    protocol: "webrtc",
    endpoint: "http://66.175.213.81:8889/benchmark/whip",
    encode_frames_total: 263,
    playback_frames_rendered: 210,
    playback_video_time_sec: 10.065,
    playback_ttff_ms: 5391,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 4 (WebRTC)",
    protocol: "webrtc",
    endpoint: "http://66.175.213.81:8889/benchmark/whip",
    encode_frames_total: 263,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 5 (RTMP)",
    protocol: "rtmp",
    endpoint: "rtmp://34.9.217.178:1935/benchmark",
    encode_frames_total: 0,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 6 (RTMP)",
    protocol: "rtmp",
    endpoint: "rtmp://34.9.217.178:1935/benchmark",
    encode_frames_total: 0,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
];

/** Last sample per series from comparison (30).csv — 4 dests after CSV dedupe. */
const COMPARISON_30: ComparisonLastRow[] = [
  {
    stream: "Stream 1 (MoQ)",
    protocol: "moq",
    endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
    encode_frames_total: 1276,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 2 (SRT)",
    protocol: "srt",
    endpoint: "srt://66.175.213.81:8890?mode=caller&latency=2000000&streamid=publish:benchmark",
    encode_frames_total: 1352,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 3 (WebRTC)",
    protocol: "webrtc",
    endpoint: "http://34.9.217.178:8889/benchmark/whip",
    encode_frames_total: 417,
    playback_frames_rendered: 390,
    playback_video_time_sec: 18.757,
    playback_ttff_ms: 3554,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 4 (RTMP)",
    protocol: "rtmp",
    endpoint: "rtmp://35.196.97.22:1935/benchmark",
    encode_frames_total: 0,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
];

const PLAYA_0X10 =
  "Catalog subscription rejected: no such namespace or track (code=0x10)";
const RTMP_224_AS_CMAF_PIPE =
  "ffmpeg I/O error: ffmpeg exited with code 224: Conversion failed!. The encoder wrote to a closed publisher pipe (publisher exited before CMAF init, or stdin was not attached yet).";
const WHIP_245 = "ffmpeg exited with code 245: [out#0/whip @ 0x5fa] Conversion failed!";

describe("comparison 29 replay", () => {
  it("collapses duplicate WHIP/RTMP series so 4 dests are not 6 CSV streams", () => {
    assert.equal(COMPARISON_29.length, 6);
    assert.equal(uniquePublishSeriesCount(COMPARISON_29), 4);
  });

  it("does not mark MPEG-TS Playback OK after a probe miss and zero paint", () => {
    const srt = visibleLeg(COMPARISON_29[1], {
      mpegTsLastReason: "manifest unreachable",
    });
    assert.equal(srt.status, "Failed");
    assert.doesNotMatch(srt.status, /Playback OK/i);
  });
});

describe("comparison 30 replay", () => {
  it("exports one series per dest", () => {
    assert.equal(uniquePublishSeriesCount(COMPARISON_30), 4);
  });

  it("treats moqx_ns=0 plus a playa 0x10 warn as never-announced, not a one-shot miss", () => {
    const moq = COMPARISON_30[0];
    assert.equal(moqxNeverAnnounced(moq), true);
    const hud = {
      playaLines: [PLAYA_0X10],
      jobStatus: "running",
      previewReady: true,
      catalogReady: false,
      namespace: "bench-9f5befdb",
    };
    const error = visibleMoqError(moq, hud);
    assert.match(error, /never announced namespace bench-9f5befdb/i);
    assert.doesNotMatch(error, /catalog object never reached/i);
    assert.equal(moqWatchdogFailsWhileEncodeRunning(moq, hud), false);
  });

  it("does not dress East RTMP 224 as a CMAF publisher pipe", () => {
    const shown = visibleLeg(COMPARISON_30[3], {
      jobError: RTMP_224_AS_CMAF_PIPE,
    });
    assert.match(shown.error ?? "", /RTMP publish failed \(ffmpeg 224\)/i);
    assert.doesNotMatch(shown.error ?? "", /CMAF init/i);
    assert.doesNotMatch(shown.error ?? "", /closed publisher pipe/i);
  });

  it("names WHIP 245 and the 18.8s stall, not a catalog or pipe story", () => {
    const job = visibleLeg(COMPARISON_30[2], { jobError: WHIP_245 });
    assert.match(job.error ?? "", /WHIP publish failed \(ffmpeg 245\)/i);
    const stall = visibleLeg(COMPARISON_30[2], { encodeDurationSec: 26 });
    assert.match(stall.error ?? "", /stalled at 18.8s of a 26s encode/i);
  });

  it("does not call SRT with zero paint Playback OK", () => {
    const srt = visibleLeg(COMPARISON_30[1], {
      mpegTsLastReason: "manifest unreachable",
    });
    assert.equal(srt.status, "Failed");
  });

  it("does not call MTX LL-HLS Encode finished after 0 paint", () => {
    const srt = visibleLeg(COMPARISON_30[1]);
    assert.notEqual(srt.status, "Playback OK");
    assert.match(srt.error ?? "", /manifest never loaded/i);
  });

  it("does not call HLS Playback OK after an 18s stall of a 26s encode", () => {
    const srt = visibleLeg(
      { ...COMPARISON_30[1], playback_frames_rendered: 400, playback_video_time_sec: 18.757 },
      { encodeDurationSec: 26 },
    );
    assert.notEqual(srt.status, "Playback OK");
    assert.match(srt.error ?? "", /stalled at 18.8s of a 26s encode/i);
  });
});
