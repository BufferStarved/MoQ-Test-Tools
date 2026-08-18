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
    // HLS / HTTP-TS still wait for a readable segment. MoQ must NOT — the
    // publisher emits the catalog as group 0 once; waiting for preview_ready
    // (often an 8s grace when moqx admin isn't reachable from a laptop)
    // means AbsoluteStart(0,0) misses it and the player sits on
    // "catalog pending" for the whole run (east local-ffmpeg 2026-08-18).
    if (job.preview_ready === false && (job.protocol || "").toLowerCase() !== "moq") {
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
