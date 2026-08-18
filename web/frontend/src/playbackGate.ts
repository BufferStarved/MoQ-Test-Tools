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
    if (job.preview_ready === false) {
      const protocol = (job.protocol || "").toLowerCase();
      // HLS / HTTP-TS wait for a readable segment. MoQ must not — catalog is
      // one-shot. WebRTC/WHEP must not — WHIP never produces HLS, so gating
      // on preview_ready left the WHEP player on "Waiting" for the whole run.
      if (protocol !== "moq" && protocol !== "webrtc") {
        return "waiting";
      }
    }
    return "live";
  }
  return "ended";
}

export function playbackGateLabel(gate: PlaybackGate, engine: "hls" | "moq" | "other"): string {
  if (gate === "waiting") {
    return engine === "hls" ? "Waiting for segments…" : "Waiting…";
  }
  return "";
}
