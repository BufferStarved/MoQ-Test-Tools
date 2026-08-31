import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyMoqEndVerdict } from "./moqCmafPlayback.ts";
import {
  comparisonLegStatusLabel,
  comparisonLegTone,
  inferCatalogReady,
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

  it("does not call Stop after 900 paints a 24.7s-of-36s stall", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 3 (WebRTC)",
      protocol: "webrtc",
      endpoint: "http://34.9.217.178:8889/benchmark/whip",
      encode_frames_total: 1080,
      playback_frames_rendered: 900,
      playback_video_time_sec: 24.7,
      playback_ttff_ms: 1200,
      moqx_publish_namespace_success: 0,
    };
    const leg = visibleLeg(row, {
      encodeDurationSec: 36,
      encodeElapsedSec: 36,
      runStopped: true,
      jobStatus: "completed",
    });
    assert.equal(leg.status, "Playback OK");
    assert.equal(leg.error, null);
    assert.doesNotMatch(leg.error ?? "", /stalled at 24\.7s of a 36s encode/i);
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
  const linodeRow: ComparisonLastRow = {
    stream: "Stream 1 (MoQ)",
    protocol: "moq",
    endpoint: "https://45-79-177-85.sslip.io:14433/moq-relay?namespace=bench-5376a8fa&draft=18",
    encode_frames_total: 900,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 1,
  };
  const linodeHud = {
    playaLines: [
      "ready levels=1 tracks=video audio=0",
      "Catalog received (bootstrap): 1 tracks",
      "[catalog-bootstrap] unknown PUBLISH_DONE status 0xffffffff — treated as retriable",
      "FAIL MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    ],
    jobStatus: "completed",
    previewReady: true,
    namespace: "bench-5376a8fa",
  };

  it("Linode catalog-ready / 0 frames is a player failure", () => {
    assert.equal(inferCatalogReady(linodeHud), true);
    const error = visibleMoqError(linodeRow, linodeHud);
    assert.equal(
      error,
      "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    );
    const leg = visibleLeg(linodeRow, linodeHud);
    assert.equal(leg.status, "Failed");
    assert.equal(leg.error, error);
    assert.equal(
      comparisonLegTone({
        protocol: "moq",
        jobStatus: "completed",
        previewReady: true,
        framesRendered: 0,
      }),
      "bad",
    );
    assert.equal(
      comparisonLegStatusLabel({
        protocol: "moq",
        jobStatus: "completed",
        previewReady: true,
        framesRendered: 0,
      }),
      "Failed",
    );
    assert.doesNotMatch(error, /Playback OK/i);
  });
});

describe("8aeaa2e4 browser LOC HUD replay", () => {
  it("catalog FETCH + video SUBSCRIBE with stub bitrate is still a player failure", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 1 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=bench-fc58e881&draft=18",
      encode_frames_total: 900,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 1,
    };
    const hud = {
      playaLines: [
        "catalog_mode=relay catalog FETCH+subscribe then video (LOC live catalog, no knownTracks race, no injected catalog) draft=18",
        "ready levels=1 tracks=video audio=0",
        "Catalog received (bootstrap): 1 tracks",
        'Subscribe video "video" requestId=4',
        "stats bitrate=2500000 latency=0 rendered=0",
        "FAIL MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
      ],
      jobStatus: "completed",
      previewReady: true,
      namespace: "bench-fc58e881",
    };
    assert.equal(inferCatalogReady(hud), true);
    const error = visibleMoqError(row, hud);
    assert.equal(
      error,
      "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    );
    const leg = visibleLeg(row, hud);
    assert.equal(leg.status, "Failed");
    assert.doesNotMatch(error, /Playback OK/i);
    assert.doesNotMatch(error, /0x10/i);
  });
});

describe("9e0a507e browser LOC HUD replay", () => {
  it("4869f0c catalog-ready / 0 paint is still a player failure", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 1 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=bench-a3d427e3&draft=18",
      encode_frames_total: 1000,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 1,
    };
    const hud = {
      playaLines: [
        "catalog_mode=relay catalog FETCH+subscribe then video (LOC live catalog, no knownTracks race, no injected catalog) draft=18",
        "ready levels=1 tracks=video audio=0",
        "Catalog received (bootstrap): 1 tracks",
        'Subscribe video "video" requestId=4',
        "stats bitrate=2500000 latency=0 rendered=0",
        "FAIL MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
      ],
      jobStatus: "completed",
      previewReady: true,
      namespace: "bench-a3d427e3",
    };
    assert.equal(inferCatalogReady(hud), true);
    const error = visibleMoqError(row, hud);
    assert.equal(
      error,
      "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    );
    const leg = visibleLeg(row, hud);
    assert.equal(leg.status, "Failed");
    assert.doesNotMatch(error, /Playback OK/i);
  });
});

describe("b2969493 browser LOC HUD replay", () => {
  it("objects + decoder configure with frame=- is still a player failure", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 1 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=bench-b2969493&draft=18",
      encode_frames_total: 800,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 1,
    };
    const hud = {
      playaLines: [
        "catalog_mode=relay catalog FETCH+subscribe then video (LOC live catalog, no knownTracks race, no injected catalog) draft=18",
        "ready levels=1 tracks=video audio=0",
        "Catalog received (bootstrap): 1 tracks",
        'Subscribe video "video" requestId=4',
        "playa [OBJ] video \"video\" group=3 obj=0 alias=4 9423B",
        "stats bitrate=2500000 latency=0 rendered=0 firstObject=1675 decoder=1627 frame=-",
        "FAIL MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
      ],
      jobStatus: "completed",
      previewReady: true,
      namespace: "bench-b2969493",
    };
    assert.equal(inferCatalogReady(hud), true);
    const error = visibleMoqError(row, hud);
    assert.equal(
      error,
      "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    );
    const leg = visibleLeg(row, hud);
    assert.equal(leg.status, "Failed");
    assert.doesNotMatch(error, /Playback OK/i);
  });
});

describe("1f61f56d browser LOC HUD replay", () => {
  it("avcC objects + catalog-ready + frame=- is still a player failure", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 1 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=bench-1f61f56d&draft=18",
      encode_frames_total: 900,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 1,
    };
    const hud = {
      playaLines: [
        "catalog_mode=relay catalog FETCH+subscribe then video (LOC live catalog, no knownTracks race, no injected catalog) draft=18",
        "ready levels=1 tracks=video audio=0",
        "play=post-catalog",
        "playa [OBJ] video \"video\" group=53 obj=0 alias=4 8222B",
        "stats bitrate=590000 latency=0 rendered=0 firstObject=2100 decoder=2200 frame=-",
        "FAIL MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
      ],
      jobStatus: "running",
      previewReady: true,
      namespace: "bench-1f61f56d",
    };
    assert.equal(inferCatalogReady(hud), true);
    const error = visibleMoqError(row, hud);
    assert.equal(
      error,
      "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    );
    const leg = visibleLeg(row, hud);
    assert.equal(leg.status, "Failed");
    assert.doesNotMatch(error, /Playback OK/i);
  });
});

describe("ca7bbb62 central leftover", () => {
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
    const leg = visibleLeg(
      {
        stream: "Stream 1 (MoQ)",
        protocol: "moq",
        endpoint: "https://34-28-164-90.sslip.io:14433/moq-relay?namespace=bench-c8c32da0&draft=18",
        encode_frames_total: 900,
        playback_frames_rendered: 0,
        playback_video_time_sec: 0,
        playback_ttff_ms: 0,
        moqx_publish_namespace_success: 1,
      },
      {
        playaLines: ["catalog track empty and its subscription ended"],
        jobStatus: "completed",
        previewReady: true,
        namespace: "bench-c8c32da0",
      },
    );
    assert.equal(leg.status, "Failed");
    assert.notEqual(leg.status, "Playback OK");
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
    const leg = visibleLeg(
      {
        stream: "Stream 1 (MoQ)",
        protocol: "moq",
        endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=bench-a1238082&draft=18",
        encode_frames_total: 900,
        playback_frames_rendered: 1,
        playback_video_time_sec: 0.03,
        playback_ttff_ms: 40,
        playback_bitrate_bps: 0,
        moqx_publish_namespace_success: 1,
      },
      {
        playaLines: [
          "subscribe_0x10_keepalive (playa warn: no such namespace)",
          "loc_frames_frozen_1",
        ],
        jobStatus: "completed",
        previewReady: true,
        catalogReady: false,
      },
    );
    assert.equal(leg.status, "Failed");
    assert.notEqual(leg.status, "Encode ended");
    assert.notEqual(leg.status, "Playback OK");
  });
});

describe("5dc53e8 BBB four-leg HUD", () => {
  it("does not call WebRTC Stop/detach at 54.0s of a 75s encode a mid-clip stall", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 3 (WebRTC)",
      protocol: "webrtc",
      endpoint: "http://34.9.217.178:8889/benchmark/whip",
      encode_frames_total: 2250,
      playback_frames_rendered: 1600,
      playback_video_time_sec: 54.0,
      playback_ttff_ms: 1200,
      moqx_publish_namespace_success: 0,
    };
    const shown = visibleLeg(row, {
      jobStatus: "completed",
      encodeDurationSec: 75,
      encodeElapsedSec: 75,
      runStopped: true,
    });
    assert.equal(shown.status, "Playback OK");
    assert.equal(shown.error, null);
    assert.doesNotMatch(shown.error ?? "", /stalled at 54/i);
  });
});

describe("BBB comparison Zixi RTMP 239 overwrite", () => {
  it("does not dress vmaf_reference File exists as an ingest close or MoQ pipe", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 4 (RTMP)",
      protocol: "rtmp",
      endpoint: "rtmp://35.222.33.58:1935/live/benchmark",
      encode_frames_total: 0,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    const shown = visibleLeg(row, {
      jobError:
        "ffmpeg exited with code 239: File '/tmp/moq-bench-jj0cwj6i/vmaf_reference.ts' already exists. Overwrite? [y/N] Not overwriting - exiting. Error opening output files: File exists.",
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /already exists/i);
    assert.match(shown.error ?? "", /overwrite prompt/i);
    assert.match(shown.error ?? "", /not an ingest close/i);
    assert.doesNotMatch(shown.error ?? "", /The ingest closed/i);
    assert.doesNotMatch(shown.error ?? "", /CMAF/i);
  });
});

describe("comparison 32 Zixi occupied RTMP 251", () => {
  it("does not dress ffmpeg 251 as ingest close after a standing canary held benchmark", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 4 (RTMP) · gcp/us-central1",
      protocol: "rtmp",
      endpoint: "rtmp://35.222.33.58:1935/live/benchmark",
      encode_frames_total: 0,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    const shown = visibleLeg(row, {
      jobStatus: "failed",
      jobError:
        "RTMP publish failed (ffmpeg 251). The ingest closed the connection — this is not a MoQ publisher pipe.",
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /already holds this stream key/i);
    assert.doesNotMatch(shown.error ?? "", /The ingest closed/i);
  });
});

describe("comparison 32 Linode Zixi SRT idle HTTP-TS", () => {
  it("fails closed on 45.33.68.151:7777 HTTP 200 + 0 TS bytes, not frozen host", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 5 (SRT) · linode/us-east",
      protocol: "srt",
      endpoint: "srt://45.33.68.151:10080?mode=caller&latency=2000000&streamid=#!::r=SRT",
      encode_frames_total: 0,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    const idle =
      "HTTP-TS origin 45.33.68.151:7777 answered HTTP 200 but sent no media (live HTTP-TS idle, or advertised an unbounded stream with no packets). This is not playback OK.";
    const shown = visibleLeg(row, {
      jobStatus: "running",
      mpegTsLastReason: idle,
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /45\.33\.68\.151:7777/);
    assert.match(shown.error ?? "", /answered HTTP 200/i);
    assert.match(shown.error ?? "", /sent no media/i);
    assert.doesNotMatch(shown.error ?? "", /frozen/i);
    assert.doesNotMatch(shown.status, /Playback OK/i);
  });
});

describe("BBB comparison Zixi :7777 probe timeout", () => {
  const row: ComparisonLastRow = {
    stream: "Stream 2 (SRT)",
    protocol: "srt",
    endpoint: "srt://35.222.33.58:10080?mode=caller&latency=2000000&streamid=#!::r=SRT",
    encode_frames_total: 1800,
    playback_frames_rendered: 0,
    playback_video_time_sec: 0,
    playback_ttff_ms: 0,
    moqx_publish_namespace_success: 0,
  };

  it("fails closed on HTTP-TS host-down timeout and does not say Playback OK", () => {
    const timeout =
      "HTTP-TS probe timed out — 35.222.33.58:7777 did not respond (origin may be frozen). This is not playback OK.";
    const srt = visibleLeg(row, {
      jobStatus: "running",
      mpegTsLastReason: timeout,
    });
    assert.equal(srt.status, "Failed");
    assert.match(srt.error ?? "", /35\.222\.33\.58:7777/);
    assert.match(srt.error ?? "", /did not respond/i);
    assert.match(srt.error ?? "", /frozen/i);
    assert.doesNotMatch(srt.status, /Playback OK/i);
  });

  it("fails closed on HTTP 200 + 0 TS bytes as idle live HTTP-TS, not host-down", () => {
    const idle =
      "HTTP-TS origin 35.222.33.58:7777 answered HTTP 200 but sent no media (live HTTP-TS idle, or advertised an unbounded stream with no packets). This is not playback OK.";
    const srt = visibleLeg(row, {
      jobStatus: "running",
      mpegTsLastReason: idle,
    });
    assert.equal(srt.status, "Failed");
    assert.match(srt.error ?? "", /answered HTTP 200/i);
    assert.match(srt.error ?? "", /sent no media/i);
    assert.doesNotMatch(srt.error ?? "", /did not respond/i);
    assert.doesNotMatch(srt.error ?? "", /frozen/i);
    assert.doesNotMatch(srt.status, /Playback OK/i);
  });
});

describe("BBB file MoQ shared-hub never-announce", () => {
  it("0x10 + catalog_timeout_skipped encode_running is never-announce, not Playback OK", () => {
    const moq: ComparisonLastRow = {
      stream: "Stream 1 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
      encode_frames_total: 2400,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    assert.equal(moqxNeverAnnounced(moq), true);
    const hud = {
      playaLines: [
        "Catalog subscription rejected: no such namespace or track (code=0x10)",
        "catalog_timeout_skipped encode_running",
        "Watchdog timeout: catalog_received after 10000ms",
      ],
      jobStatus: "running",
      previewReady: false,
      catalogReady: false,
      namespace: "bench-bbb-file",
      encodeDurationSec: 75,
      encodeElapsedSec: 115,
    };
    const error = visibleMoqError(moq, hud);
    assert.match(error, /never announced namespace bench-bbb-file/i);
    assert.match(error, /SUBSCRIBE 0x10/i);
    assert.doesNotMatch(error, /catalog object never reached/i);
    assert.doesNotMatch(error, /Playback OK/i);
    const leg = visibleLeg(moq, hud);
    assert.equal(leg.status, "Failed");
    assert.notEqual(leg.status, "Playback OK");
  });
});

describe("headed East Zixi SRT 3c0a875f remount-then-stall", () => {
  it("does not say MPEG-TS never painted after 1067 paints / 35.4s of a 60s encode", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 3 (SRT) · gcp/us-east1",
      protocol: "srt",
      endpoint: "srt://35.196.215.179:10080?mode=caller&latency=2000000&streamid=#!::r=SRT",
      encode_frames_total: 1800,
      playback_frames_rendered: 1067,
      playback_video_time_sec: 35.391846,
      playback_ttff_ms: 4002,
      moqx_publish_namespace_success: 0,
    };
    const shown = visibleLeg(row, {
      jobStatus: "completed",
      mpegTsLastReason: "MPEG-TS never painted. Encode-only is not playback.",
      encodeDurationSec: 60,
      encodeElapsedSec: 59,
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /stalled at 35\.4s of a 60s encode/i);
    assert.doesNotMatch(shown.error ?? "", /never painted/i);
    assert.doesNotMatch(shown.status, /Playback OK/i);
  });
});

describe("helper laptop SRT idle before encode frames", () => {
  it("fails closed on Zixi Central idle HTTP-TS without calling Playback OK", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 2 (SRT) · gcp/us-central1",
      protocol: "srt",
      endpoint: "srt://35.222.33.58:10080?mode=caller&latency=2000000&streamid=#!::r=SRT",
      encode_frames_total: 0,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    const idle =
      "HTTP-TS origin 35.222.33.58:7777 answered HTTP 200 but sent no media (live HTTP-TS idle, or advertised an unbounded stream with no packets). This is not playback OK.";
    const shown = visibleLeg(row, {
      jobStatus: "running",
      mpegTsLastReason: idle,
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /35\.222\.33\.58:7777/);
    assert.match(shown.error ?? "", /answered HTTP 200/i);
    assert.match(shown.error ?? "", /sent no media/i);
    assert.doesNotMatch(shown.error ?? "", /frozen/i);
    assert.doesNotMatch(shown.status, /Playback OK/i);
  });
});

describe("helper laptop SRT idle after webcam encode frames", () => {
  it("fails closed on idle HTTP-TS even when the helper already encoded 90 frames", () => {
    const row: ComparisonLastRow = {
      stream: "Stream 2 (SRT) · gcp/us-central1",
      protocol: "srt",
      endpoint: "srt://35.222.33.58:10080?mode=caller&latency=2000000&streamid=#!::r=SRT",
      encode_frames_total: 90,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    const idle =
      "HTTP-TS origin 35.222.33.58:7777 answered HTTP 200 but sent no media (live HTTP-TS idle, or advertised an unbounded stream with no packets). This is not playback OK.";
    const shown = visibleLeg(row, {
      jobStatus: "running",
      mpegTsLastReason: idle,
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /sent no media/i);
    assert.doesNotMatch(shown.status, /Playback OK/i);
  });
});

describe("helper laptop MoQ WT never connected", () => {
  it("keeps 0x10 as a publisher CONNECT miss, not a catalog miss", () => {
    const moq: ComparisonLastRow = {
      stream: "Stream 1 (MoQ)",
      protocol: "moq",
      endpoint: "https://34-28-164-90.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
      encode_frames_total: 240,
      playback_frames_rendered: 0,
      playback_video_time_sec: 0,
      playback_ttff_ms: 0,
      moqx_publish_namespace_success: 0,
    };
    const jobError =
      "The publisher ran but did not connect to the relay (WebTransport session never connected; no connection_id). relay=https://34-28-164-90.sslip.io:14433/moq-relay binary=/Users/sean/Developer/moq-test-tools/tools/moq5-publisher/bin/moq5-fmp4-publish draft=18.";
    const shown = visibleLeg(moq, {
      playaLines: [
        "Catalog subscription rejected: no such namespace or track (code=0x10)",
        "catalog pending",
      ],
      jobStatus: "failed",
      jobError,
      previewReady: false,
      catalogReady: false,
      namespace: "bench-helper",
    });
    assert.equal(shown.status, "Failed");
    assert.match(shown.error ?? "", /did not connect to the relay/i);
    assert.match(shown.error ?? "", /not a player/i);
    assert.doesNotMatch(shown.error ?? "", /one-shot catalog miss/i);
    assert.doesNotMatch(shown.error ?? "", /catalog object never reached/i);
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
