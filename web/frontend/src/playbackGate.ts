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
      ? "Waiting for encode to start and Zixi HLS output to become available..."
      : "Waiting for encode to start and MoQ publish to begin...";
  }
  if (gate === "ended") {
    return "Encode finished. Expand diagnostics below if preview never played.";
  }
  return "";
}
