import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uniqueDownloadStreams } from "./downloadStreams.ts";

describe("uniqueDownloadStreams", () => {
  it("keeps one series when two files share a WHIP or RTMP URL", () => {
    const unique = uniqueDownloadStreams([
      {
        label: "Stream 3 (WebRTC)",
        filename: "a.csv",
        protocol: "webrtc",
        endpoint: "http://66.175.213.81:8889/benchmark/whip",
        paint: 210,
      },
      {
        label: "Stream 4 (WebRTC)",
        filename: "b.csv",
        protocol: "webrtc",
        endpoint: "http://66.175.213.81:8889/benchmark/whip",
        paint: 0,
      },
      {
        label: "Stream 5 (RTMP)",
        filename: "c.csv",
        protocol: "rtmp",
        endpoint: "rtmp://34.9.217.178:1935/benchmark",
        paint: 0,
      },
      {
        label: "Stream 6 (RTMP)",
        filename: "d.csv",
        protocol: "rtmp",
        endpoint: "rtmp://34.9.217.178:1935/benchmark",
        paint: 0,
      },
    ]);
    assert.deepEqual(
      unique.map((stream) => stream.label),
      ["Stream 3 (WebRTC)", "Stream 5 (RTMP)"],
    );
  });

  it("does not merge two MoQ namespaces on the same relay", () => {
    const unique = uniqueDownloadStreams([
      {
        label: "Stream 1 (MoQ)",
        filename: "east.csv",
        protocol: "moq",
        endpoint: "https://east.example:14433/moq-relay?namespace=a",
      },
      {
        label: "Stream 2 (MoQ)",
        filename: "west.csv",
        protocol: "moq",
        endpoint: "https://east.example:14433/moq-relay?namespace=b",
      },
    ]);
    assert.equal(unique.length, 2);
  });
});
