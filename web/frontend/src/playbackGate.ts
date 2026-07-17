import type { UploadJob } from "./types";

export type PlaybackGate = "idle" | "waiting" | "live" | "ended";

export function playbackGateForJob(job: UploadJob | undefined, benchmarkStarting: boolean): PlaybackGate {
  if (benchmarkStarting && !job) {
    return "waiting";
  }
  if (!job) {
    return "idle";
  }
  if (job.status === "pending") {
    return "waiting";
  }
  if (job.status === "running") {
    // Keep HLS players gated until the backend confirms a readable Zixi segment.
    // Mounting hls.js earlier just storms fragLoadError on chunk=0 HTTP 400.
    if (job.protocol === "srt" && job.preview_ready === false) {
      return "waiting";
    }
    return "live";
  }
  return "ended";
}

export function playbackGateLabel(gate: PlaybackGate, engine: "hls" | "moq" | "other"): string {
  if (gate === "idle") {
    return "Start a benchmark encode to preview this stream.";
  }
  if (gate === "waiting") {
    return engine === "hls"
      ? "Waiting for encode to start and Zixi HLS segments to become readable..."
      : "Waiting for encode to start and MoQ publish to begin...";
  }
  if (gate === "ended") {
    return "Encode finished. Expand diagnostics below if preview never played.";
  }
  return "";
}
