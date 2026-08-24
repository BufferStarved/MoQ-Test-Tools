import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { protocolLabel } from "./protocolTheme.ts";
import {
  buildComparisonPoints,
  comparisonSeries,
  comparisonVisibleGroups,
  resultToSavedStream,
  rowsToChartPoints,
  savedStreamsToLegs,
  unmeasuredIngestValue,
  ttffEventSummaries,
  type ComparisonLegData,
} from "./chartData.ts";
import type { ResultSummary } from "./types.ts";

function row(partial: Record<string, string>): Record<string, string> {
  return {
    timestamp: "0",
    encoded_bitrate_kbps: "0",
    fps: "0",
    ...partial,
  };
}

/** 2 of 4 streams — MoQ painted frames, RTMP encode-only, empty WebRTC, no SRT. */
function comparison16Streams(): ResultSummary[] {
  const moqRows = Array.from({ length: 8 }, (_, index) =>
    row({
      timestamp: String(1_787_193_084 + index * 2),
      protocol: "moq",
      encoded_bitrate_kbps: index === 0 ? "0" : "2400",
      fps: index === 0 ? "0" : "30",
      playback_ttff_ms: index >= 2 ? "631" : "0",
      playback_frames_rendered: index >= 2 ? String(30 * (index - 1)) : "0",
      playback_frames_dropped: "0",
      playback_stall_count: "0",
      playback_buffer_sec: index >= 2 ? "0.76" : "0",
      playback_video_time_sec: index >= 2 ? String(index - 1) : "0",
      e2e_latency_ms: index >= 2 ? "2460" : "0",
    }),
  );
  const rtmpRows = Array.from({ length: 6 }, (_, index) =>
    row({
      timestamp: String(1_787_193_155 + index),
      protocol: "rtmp",
      encoded_bitrate_kbps: index === 0 ? "54" : "2200",
      fps: index < 2 ? "0" : "29.99",
      encode_lag_ms: "12",
      playback_ttff_ms: "0",
      playback_frames_rendered: "0",
    }),
  );
  return [
    {
      filename: "upload_cmp16_moq.csv",
      samples: moqRows.length,
      protocol: "moq",
      endpoint: "https://relay.example/anon",
      averages: {
        cpu_percent: 12,
        memory_mb: 200,
        encoded_bitrate_kbps: 2400,
        fps: 30,
        speed: 1,
        playback_ttff_ms: 631,
        playback_frames_rendered: 210,
        playback_frames_dropped: 0,
        e2e_latency_ms: 2460,
      },
      rows: moqRows,
      summary_extra: { comparison_id: "cmp-16", stream_index: 0, stream_label: "Stream 1 (MOQ)" },
      quality: {},
    },
    {
      filename: "upload_cmp16_rtmp.csv",
      samples: rtmpRows.length,
      protocol: "rtmp",
      endpoint: "rtmp://zixi.example/live",
      averages: {
        cpu_percent: 18,
        memory_mb: 180,
        encoded_bitrate_kbps: 1800,
        fps: 29.9,
        speed: 1,
        encode_lag_ms: 12,
      },
      rows: rtmpRows,
      summary_extra: { comparison_id: "cmp-16", stream_index: 2, stream_label: "Stream 3 (RTMP)" },
      quality: {},
    },
    {
      filename: "upload_cmp16_webrtc.csv",
      samples: 0,
      protocol: null,
      endpoint: null,
      averages: {},
      rows: [],
      summary_extra: { comparison_id: "cmp-16", stream_index: 3 },
    },
  ];
}

/** Browser 2-way stop mid-run — integer elapsed timestamps, no VMAF. */
function browserTwoWayStop(): ResultSummary[] {
  const rowsFor = (protocol: string) =>
    Array.from({ length: 21 }, (_, index) =>
      row({
        timestamp: String(index),
        protocol,
        encoded_bitrate_kbps: index < 2 ? "0" : protocol === "webrtc" ? "0" : "5500",
        fps: index < 2 ? "0" : "25",
        playback_ttff_ms: protocol === "webrtc" && index >= 8 ? "7577" : "0",
        playback_frames_rendered:
          protocol === "webrtc" && index >= 8 ? String((index - 7) * 12) : "0",
      }),
    );
  return [
    {
      filename: "upload_browser_moq.csv",
      samples: 21,
      protocol: "moq",
      endpoint: "https://relay.example/anon",
      averages: { cpu_percent: 20, memory_mb: 90, encoded_bitrate_kbps: 5400, fps: 25, speed: 1 },
      rows: rowsFor("moq"),
    },
    {
      filename: "upload_browser_webrtc.csv",
      samples: 21,
      protocol: "webrtc",
      endpoint: "https://mediamtx.example/whip",
      averages: {
        cpu_percent: 15,
        memory_mb: 80,
        encoded_bitrate_kbps: 0,
        fps: 28,
        speed: 1,
        playback_ttff_ms: 7577,
        playback_frames_rendered: 156,
      },
      rows: rowsFor("webrtc"),
    },
  ];
}

function emptySession(): ResultSummary[] {
  return [];
}

function emptyFailedLeg(): ResultSummary[] {
  return [
    {
      filename: "upload_empty.csv",
      samples: 0,
      protocol: null,
      averages: {},
      rows: [],
    },
  ];
}

function buildResultsCharts(streams: ResultSummary[]) {
  const labels = streams.map(
    (result, index) =>
      result.summary_extra?.stream_label || `Stream ${index + 1} (${protocolLabel(result.protocol)})`,
  );
  const saved = streams.map((result, index) => ({
    ...resultToSavedStream(result, index),
    label: labels[index],
  }));
  const legs: ComparisonLegData[] = savedStreamsToLegs(saved);
  const points = buildComparisonPoints(legs);
  const groups = comparisonVisibleGroups(points, legs);
  const series = comparisonSeries(legs, "encoded_bitrate_kbps", "kbps");
  const ttff = ttffEventSummaries(legs, points);
  return { labels, legs, points, groups, series, ttff };
}

describe("Results chart data cannot crash the tab", () => {
  it("builds comparison (16) — 2 of 4 streams, MoQ frames, RTMP encode-only", () => {
    const model = buildResultsCharts(comparison16Streams());
    assert.equal(model.legs.length, 3);
    assert.ok(model.points.length > 0);
    assert.ok(model.points.length < 120);
    assert.ok(model.groups.some((group) => group.id === "encode"));
    assert.equal(model.series.length, 3);
    assert.match(model.ttff[0], /first frame/);
    assert.match(model.ttff[1], /no first frame/);
    assert.equal(protocolLabel(null), "Stream");
    assert.equal(model.labels[2], "Stream 3 (Stream)");
  });

  it("builds a browser 2-way stop mid-run", () => {
    const model = buildResultsCharts(browserTwoWayStop());
    assert.equal(model.legs.length, 2);
    assert.equal(model.points.length, 21);
    assert.ok(model.groups.length >= 1);
    assert.ok(model.ttff.some((line) => line.includes("first frame")));
  });

  it("builds an empty session and a header-only failed leg", () => {
    assert.deepEqual(buildResultsCharts(emptySession()).points, []);
    const failed = buildResultsCharts(emptyFailedLeg());
    assert.equal(failed.legs.length, 1);
    assert.equal(failed.points.length, 0);
    assert.equal(failed.labels[0], "Stream 1 (Stream)");
  });

  it("carries sparse SRT points onto the 1s comparison axis", () => {
    const legs: ComparisonLegData[] = [
      {
        id: "rtmp",
        label: "RTMP",
        protocol: "rtmp",
        samples: [
          { elapsed_sec: 1, encoded_bitrate_kbps: 2000, fps: 30, e2e_latency_ms: 9000 } as never,
          { elapsed_sec: 2, encoded_bitrate_kbps: 2100, fps: 30, e2e_latency_ms: 9100 } as never,
          { elapsed_sec: 3, encoded_bitrate_kbps: 2200, fps: 30, e2e_latency_ms: 9200 } as never,
        ],
      },
      {
        id: "srt",
        label: "SRT",
        protocol: "srt",
        samples: [
          { elapsed_sec: 2, encoded_bitrate_kbps: 3300, fps: 30, e2e_latency_ms: 8800 } as never,
        ],
      },
    ];
    const points = buildComparisonPoints(legs);
    const at1 = points.find((point) => point.second === 1);
    const at2 = points.find((point) => point.second === 2);
    const at3 = points.find((point) => point.second === 3);
    assert.equal(at1?.e2e_latency_ms_1, undefined);
    assert.equal(at2?.e2e_latency_ms_1, 8800);
    assert.equal(at3?.e2e_latency_ms_1, 8800);
    assert.ok((at3?.e2e_latency_ms_0 ?? 0) > 0);
  });

  it("keeps media-health and playback tabs on a clean live run", () => {
    const legs: ComparisonLegData[] = [
      {
        id: "moq",
        label: "MoQ",
        protocol: "moq",
        samples: [
          {
            elapsed_sec: 1,
            encoded_bitrate_kbps: 2400,
            fps: 30,
            encode_lag_ms: 0,
            cmaf_seq_gap_count: 0,
            playback_stall_count: 0,
          } as never,
        ],
      },
      {
        id: "srt",
        label: "SRT",
        protocol: "srt",
        samples: [
          {
            elapsed_sec: 1,
            encoded_bitrate_kbps: 2400,
            fps: 30,
            encode_lag_ms: 0,
            ts_continuity_counter_errors: 0,
          } as never,
        ],
      },
    ];
    const points = buildComparisonPoints(legs);
    const groups = comparisonVisibleGroups(points, legs).map((group) => group.id);
    assert.ok(groups.includes("encode"));
    assert.ok(groups.includes("ingest"));
    assert.ok(groups.includes("media_health"));
    assert.ok(groups.includes("playback"));
    assert.equal(points[0]?.encode_lag_ms_0, 0);
    assert.equal(points[0]?.cmaf_seq_gap_count_0, 0);
  });

  it("plots MoQ qlog RTT and nulls only the first unmeasured samples", () => {
    assert.equal(unmeasuredIngestValue("moq", "net_rtt_ms", 0), null);
    assert.equal(unmeasuredIngestValue("moq", "quic_rtt_ms", 0), null);
    assert.equal(unmeasuredIngestValue("moq", "net_rtt_ms", 38.4), 38.4);
    const points = rowsToChartPoints([
      row({
        protocol: "moq",
        timestamp: "1",
        net_rtt_ms: "0",
        net_jitter_ms: "0",
        quic_rtt_ms: "0",
      }),
      row({
        protocol: "moq",
        timestamp: "2",
        net_rtt_ms: "38.4",
        net_jitter_ms: "1.2",
        quic_rtt_ms: "38.4",
      }),
    ]);
    assert.equal(points[0].net_rtt_ms, null);
    assert.equal(points[0].quic_rtt_ms, null);
    assert.equal(points[1].net_rtt_ms, 38.4);
    assert.equal(points[1].net_jitter_ms, 1.2);
    assert.equal(points[1].quic_rtt_ms, 38.4);
  });

  it("does not allocate a unix-epoch x-axis", () => {
    const poison: ResultSummary = {
      filename: "poison.csv",
      samples: 2,
      protocol: "moq",
      averages: { cpu_percent: 1, memory_mb: 1, encoded_bitrate_kbps: 1, fps: 1, speed: 1 },
      rows: [
        row({ timestamp: "10", encoded_bitrate_kbps: "1000", fps: "30" }),
        row({ timestamp: "1787193155", encoded_bitrate_kbps: "1000", fps: "30" }),
      ],
    };
    const model = buildResultsCharts([poison]);
    assert.ok(model.points.length <= 3);
    assert.ok(model.points.every((point) => point.second <= 4 * 60 * 60));
  });
});
