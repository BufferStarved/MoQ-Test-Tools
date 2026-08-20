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
      if (protocol === "webrtc" && !browser) {
        return "live";
      }
      // SRT/RTMP MPEG-TS can attach while Fast HLS is still wedged. The HLS
      // player keeps its own manifest wait; blocking the gate on HLS health
      // delayed a working HTTP-TS path by tens of seconds.
      if (protocol === "srt" || protocol === "rtmp") {
        return "live";
      }
      // ffmpeg CMAF catalog is a one-shot group-0 object. Waiting until
      // preview_ready (announce already happened) SUBSCRIBEs after the
      // catalog is gone — ingest looks healthy, glass never starts
      // (bench-bbc4eb3c). Subscribe on running + 0x10 keepalive catches it.
      // Do not tear the session down on the 4s catalog timer while announce
      // is still pending (webcam publish can take longer than 4s).
      if (protocol === "moq") {
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
