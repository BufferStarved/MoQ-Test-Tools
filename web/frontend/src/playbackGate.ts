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
    // Keep players gated until the backend confirms readable delivery media
    // (Zixi HTTP-TS / Fast HLS, or MediaMTX LL-HLS). Attaching earlier storms
    // empty-playlist / empty-.ts errors and inflates TTFF.
    if (job.preview_ready === false) {
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
