import type { UploadJob } from "./types";

export type PlaybackGate = "idle" | "waiting" | "live" | "ended";

export function playbackGateForJob(job: UploadJob | undefined, benchmarkStarting: boolean): PlaybackGate {
  if (benchmarkStarting && !job) {
    return "waiting";
  }
  if (!job) {
    return "idle";
  }
  if (job.status === "pending" || job.status === "queued") {
    return "waiting";
  }
  if (job.status === "running") {
    if (job.preview_ready === false) {
      const protocol = (job.protocol || "").toLowerCase();
      const browser = (job.publisher_host || "").toLowerCase() === "browser";
      // Browser LOC/WHIP: wait until the in-page publisher has a first IDR
      // (MoQ) or ICE-connected WHIP. Going live earlier SUBSCRIBEs
      // LargestObject on an empty track — moqx never attached later groups
      // (linode 0 frames while the later GCP subscribe painted).
      if (browser && (protocol === "moq" || protocol === "webrtc")) {
        return "waiting";
      }
      // HLS / HTTP-TS wait for a readable segment. ffmpeg MoQ must not —
      // catalog is one-shot. Cloud/local WebRTC must not — WHIP never
      // produces HLS, so gating on preview_ready left WHEP on "Waiting".
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

export function waitingPlayerStatus(options: {
  engine: "hls" | "moq" | "other";
  jobStatus?: string;
  waitingForEncodeSlot?: boolean;
  encodeQueueAhead?: number;
}): string {
  const queued =
    options.waitingForEncodeSlot ||
    options.jobStatus === "queued" ||
    options.jobStatus === "pending";
  if (queued) {
    const ahead = options.encodeQueueAhead ?? 0;
    if (options.jobStatus === "pending") {
      return "Waiting for encode to start...";
    }
    if (ahead > 0) {
      return `Waiting for encode slot (${ahead} ahead)...`;
    }
    return "Waiting for encode slot...";
  }
  if (options.engine === "hls") {
    return "Waiting for readable HLS segments...";
  }
  if (options.engine === "moq") {
    return "Waiting for MoQ publish...";
  }
  return "Waiting for encode...";
}
