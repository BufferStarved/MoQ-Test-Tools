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
      // Cloud WHIP has no preview_ready signal — WHEP must attach on running.
      // ffmpeg MoQ must wait for the relay namespace announce. Going live
      // earlier SUBSCRIBEs catalog before PUBLISH_NAMESPACE, gets 0x10, and
      // burns the one-shot catalog (bench-733f1d7c: 240 CMAF fragments,
      // moqx_ns=0, tile showed catalog-miss).
      if (protocol === "webrtc" && !browser) {
        return "live";
      }
      // SRT/RTMP MPEG-TS can attach while Fast HLS is still wedged. The HLS
      // player keeps its own manifest wait; blocking the gate on HLS health
      // delayed a working HTTP-TS path by tens of seconds.
      if (protocol === "srt" || protocol === "rtmp") {
        return "live";
      }
      return "waiting";
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
