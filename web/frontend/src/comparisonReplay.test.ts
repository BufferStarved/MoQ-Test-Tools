import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyMoqEndVerdict } from "./moqCmafPlayback.ts";
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

/** Last sample per series from comparison (31).csv — 4 dests, 0 paint, encode ~0.3x. */
const COMPARISON_31: ComparisonLastRow[] = [
  {
    stream: "Stream 1 (MoQ)",
    protocol: "moq",
    endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
    encode_frames_total: 846,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 1,
  },
  {
    stream: "Stream 2 (RTMP)",
    protocol: "rtmp",
    endpoint: "rtmp://45.33.68.151:1935/live/benchmark",
    encode_frames_total: 872,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 3 (SRT)",
    protocol: "srt",
    endpoint: "srt://66.175.213.81:8890?mode=caller&latency=2000000&streamid=publish:benchmark",
    encode_frames_total: 861,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
  {
    stream: "Stream 4 (SRT)",
    protocol: "srt",
    endpoint: "srt://35.196.97.22:8890?mode=caller&latency=2000000&streamid=publish:benchmark",
    encode_frames_total: 876,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  },
];

describe("comparison 31 replay", () => {
  it("exports one series per dest", () => {
    assert.equal(uniquePublishSeriesCount(COMPARISON_31), 4);
  });

  it("does not call late ns=1 plus 0x10 a never-announce or one-shot miss", () => {
    const moq = COMPARISON_31[0];
    assert.equal(moqxNeverAnnounced(moq), false);
    const error = visibleMoqError(moq, {
      playaLines: [
        "subscribe_0x10_keepalive (playa warn: no such namespace)",
        "Catalog subscription rejected: no such namespace or track (code=0x10)",
        "Watchdog timeout: catalog_received after 10004ms",
      ],
      jobStatus: "completed",
      previewReady: false,
      catalogReady: false,
      namespace: "bench-comparison-31",
    });
    assert.match(error, /after SUBSCRIBE 0x10/i);
    assert.match(error, /watchdog expired/i);
    assert.doesNotMatch(error, /never announced/i);
    assert.doesNotMatch(error, /catalog object never reached/i);
  });

  it("does not call SRT/RTMP with zero paint Playback OK", () => {
    for (const row of COMPARISON_31.slice(1)) {
      const leg = visibleLeg(row, { encodeDurationSec: 60 });
      assert.notEqual(leg.status, "Playback OK");
      assert.match(leg.error ?? "", /manifest never loaded|never painted/i);
    }
  });
});

describe("ca7bbb62 browser LOC HUD replay", () => {
  it("Linode catalog-ready / 0 frames is a player failure", () => {
    const error = visibleMoqError(
      {
        stream: "Stream 1 (MoQ)",
        protocol: "moq",
        endpoint: "https://45-79-177-85.sslip.io:14433/moq-relay?namespace=bench-5376a8fa&draft=18",
        encode_frames_total: 900,
        playback_frames_rendered: 0,
        playback_video_time_sec: 0,
        playback_ttff_ms: 0,
        moqx_publish_namespace_success: 1,
      },
      {
        playaLines: [
          "ready levels=1 tracks=video audio=0",
          "Catalog received (bootstrap): 1 tracks",
          "[catalog-bootstrap] unknown PUBLISH_DONE status 0xffffffff — treated as retriable",
          "FAIL MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
        ],
        catalogReady: true,
        jobStatus: "completed",
        namespace: "bench-5376a8fa",
      },
    );
    assert.match(error, /catalog loaded but no video/i);
    assert.doesNotMatch(error, /Playback OK/i);
  });

  it("GCP Central empty catalog + subscription ended is not Playback OK", () => {
    const verdict = classifyMoqEndVerdict({
      framesRendered: 0,
      catalogReady: false,
      encodeDurationSec: 30,
      jobStatus: "completed",
      lastError: "catalog track empty and its subscription ended",
      namespace: "bench-c8c32da0",
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /catalog track empty/i);
    assert.notEqual(verdict.status, "Playback OK");
  });

  it("GCP East leftover rendered=1 after 0x10 is not Encode ended", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: true,
      framesRendered: 1,
      videoTimeSec: 0.03,
      bitrateBps: 0,
      subscribeRejected: true,
      catalogReady: false,
      encodeDurationSec: 30,
      encodeElapsedSec: 30,
      jobStatus: "completed",
    });
    assert.equal(verdict.ok, false);
    assert.notEqual(verdict.status, "Encode ended");
    assert.notEqual(verdict.status, "Playback OK");
  });
});

describe("custom 4-way bench-aef84d9a replay", () => {
  it("does not call completed + 0x10 + 0 paint a catalog miss", () => {
    const moq: ComparisonLastRow = {
      stream: "Stream 4 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-28-164-90.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
      encode_frames_total: 1500,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    assert.equal(moqxNeverAnnounced(moq), true);
    const error = visibleMoqError(moq, {
      playaLines: [
        "subscribe_0x10_keepalive (playa warn: no such namespace)",
        "Catalog subscription rejected: no such namespace or track (code=0x10)",
        "catalog_timeout_skipped encode_running",
      ],
      jobStatus: "completed",
      previewReady: false,
      catalogReady: false,
      namespace: "bench-aef84d9a",
    });
    assert.match(error, /never announced namespace bench-aef84d9a/i);
    assert.match(error, /SUBSCRIBE 0x10/i);
    assert.doesNotMatch(error, /catalog object never reached/i);
  });
});
