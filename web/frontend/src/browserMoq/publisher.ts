import { postEncodeSample, postPublisherError, postPublisherReady, uploadVmafReference } from "../api";
import { detectBrowserMoqCapabilities } from "./capabilities";
import { startBrowserCapture, type BrowserCapture } from "./capture";
import {
  createBrowserVideoEncoder,
  pickBrowserVideoCodec,
  type BrowserEncoder,
} from "./encoder";
import { createH264AnnexBMuxer } from "./h264AnnexB";
import { connectMoq5WasmPublisher, type Moq5PublishSession } from "./moq5Service";
import type { MoqtDraftVersion } from "./moqtVersions";
import { startWhipPublish, type WhipPublishSession } from "./whipPublisher";
import { setLocIdrNudge } from "./locIdrNudge";

export interface BrowserMoqLeg {
  jobId: string;
  protocol?: "moq" | "webrtc";
  relayUrl?: string;
  namespace?: string;
  fingerprintUrl?: string;
  whipUrl?: string;
  ingestVmaf?: boolean;
  draftVersion?: MoqtDraftVersion;
}

export interface BrowserMoqRun {
  hasAudio: boolean;
  videoCodec: string;
  previewStream: MediaStream;
  draftByJobId: Record<string, MoqtDraftVersion>;
  stop: () => void;
}

function isWhipLeg(leg: BrowserMoqLeg): boolean {
  return (leg.protocol || "moq") === "webrtc" || Boolean(leg.whipUrl && !leg.relayUrl);
}

export async function startBrowserMoqPublish(options: {
  legs: BrowserMoqLeg[];
}): Promise<BrowserMoqRun> {
  const moqLegs = options.legs.filter((leg) => !isWhipLeg(leg));
  const whipLegs = options.legs.filter((leg) => isWhipLeg(leg));
  const caps = detectBrowserMoqCapabilities();
  if (!caps.getUserMedia || !caps.secureContext) {
    throw new Error(caps.reason || "Browser publish is not available.");
  }
  if (moqLegs.length > 0 && !(caps.webTransport && caps.webCodecs)) {
    throw new Error(caps.reason || "Browser MoQ publish is not available.");
  }
  if (whipLegs.length > 0 && typeof RTCPeerConnection === "undefined") {
    throw new Error("This browser cannot open a WebRTC peer connection.");
  }
  const capture: BrowserCapture = await startBrowserCapture();
  const videoTrack = capture.stream.getVideoTracks()[0];
  if (!videoTrack) {
    capture.stop();
    throw new Error("No camera video track.");
  }
  // Video-only until audio subgroups stop blowing moqx's uni-stream limit
  // (relay log on bench-24c990ee: beginSubgroup failed, audio subscriber dropped).
  const includeAudio = false;
  const settings = videoTrack.getSettings();
  const width = settings.width || 1280;
  const height = settings.height || 720;
  const videoCodec = moqLegs.length ? await pickBrowserVideoCodec() : "";
  const vmafLegs = moqLegs.filter((leg) => leg.ingestVmaf);
  const annexB = vmafLegs.length ? createH264AnnexBMuxer() : null;

  const sessions: Moq5PublishSession[] = [];
  const whipSessions: WhipPublishSession[] = [];
  const encoders: BrowserEncoder[] = [];
  const draftByJobId: Record<string, MoqtDraftVersion> = {};
  let stopped = false;
  let requestKeyframe: () => void = () => undefined;
  let vmafTimer: number | null = null;
  let lastUploadedBytes = 0;

  async function flushVmafReference() {
    if (!annexB || annexB.byteLength() < 8_000 || annexB.byteLength() === lastUploadedBytes) {
      return;
    }
    lastUploadedBytes = annexB.byteLength();
    const blob = annexB.toBlob();
    await Promise.all(
      vmafLegs.map((leg) =>
        uploadVmafReference(leg.jobId, blob, "reference.h264").catch(() => undefined),
      ),
    );
  }

  try {
    for (const leg of whipLegs) {
      if (!leg.whipUrl) {
        throw new Error("WebRTC output is missing a WHIP publish URL.");
      }
    }
    const whipStart = Promise.allSettled(
      whipLegs.map(async (leg) => {
        const session = await startWhipPublish({
          stream: capture.stream,
          whipUrl: leg.whipUrl || "",
          jobId: leg.jobId,
          includeAudio,
          onFatalError: (message) => {
            void postPublisherError(leg.jobId, message);
          },
        });
        return { leg, session };
      }),
    );
    const moqStart = Promise.allSettled(
      moqLegs.map(async (leg) => {
        const session = await connectMoq5WasmPublisher({
          relayUrl: leg.relayUrl || "",
          namespace: leg.namespace || "benchmark",
          fingerprintUrl: leg.fingerprintUrl,
          width,
          height,
          includeAudio,
          videoCodec,
          draftVersion: leg.draftVersion ?? 18,
          onVideoSubscribed: () => requestKeyframe(),
        });
        return { leg, session };
      }),
    );
    const [whipResults, moqResults] = await Promise.all([whipStart, moqStart]);
    const whipErrors: string[] = [];
    for (const result of whipResults) {
      if (result.status === "fulfilled") {
        whipSessions.push(result.value.session);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        whipErrors.push(reason);
      }
    }
    for (const [index, result] of whipResults.entries()) {
      if (result.status === "rejected") {
        const leg = whipLegs[index];
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (leg) {
          void postPublisherError(leg.jobId, reason);
        }
      }
    }
    if (whipLegs.length > 0 && whipSessions.length === 0 && moqLegs.length === 0) {
      throw new Error(whipErrors[0] || "Browser WebRTC publish failed on every MediaMTX.");
    }

    const liveMoqLegs: BrowserMoqLeg[] = [];
    const moqErrors: string[] = [];
    for (const [index, result] of moqResults.entries()) {
      if (result.status === "fulfilled") {
        sessions.push(result.value.session);
        draftByJobId[result.value.leg.jobId] = result.value.session.draftVersion;
        liveMoqLegs.push(result.value.leg);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        moqErrors.push(reason);
        const leg = moqLegs[index];
        if (leg) {
          void postPublisherError(leg.jobId, reason);
        }
      }
    }
    if (moqLegs.length > 0 && sessions.length === 0) {
      throw new Error(moqErrors[0] || "Browser MoQ publish failed on every relay.");
    }
    if (moqErrors.length) {
      console.warn("Some MoQ relays did not accept this publish:", moqErrors.join(" | "));
    }

    let firstIdrPosted = false;
    let resolveFirstIdr: (() => void) | null = null;
    const firstIdr = new Promise<void>((resolve) => {
      resolveFirstIdr = resolve;
    });

    if (moqLegs.length > 0) {
      const encoder = createBrowserVideoEncoder(
        videoTrack,
        (chunk) => {
          if (stopped) {
            return;
          }
          annexB?.push(chunk.data, chunk.description);
          for (const session of sessions) {
            session.publishVideo(chunk);
          }
          if (chunk.isKeyframe && !firstIdrPosted) {
            firstIdrPosted = true;
            resolveFirstIdr?.();
          }
        },
        (sample) => {
          if (stopped) {
            return;
          }
          for (const leg of liveMoqLegs) {
            void postEncodeSample(leg.jobId, {
              elapsed_sec: sample.elapsedSec,
              encoded_bitrate_kbps: sample.encodedBitrateKbps,
              fps: sample.fps,
              encoder_send_rate_mbps: sample.encodedBitrateKbps / 1000,
              encode_lag_ms: sample.encodeLagMs,
            }).catch(() => undefined);
          }
        },
        videoCodec,
      );
      encoders.push(encoder);
      requestKeyframe = () => encoder.requestKeyframe();
      setLocIdrNudge(requestKeyframe);
      await encoder.start();
      await Promise.race([
        firstIdr,
        new Promise<void>((resolve) => window.setTimeout(resolve, 2500)),
      ]);
      await Promise.all(
        liveMoqLegs.map((leg) => postPublisherReady(leg.jobId).catch(() => undefined)),
      );
    }
    if (annexB) {
      // One mid-run upload is enough for ingest VMAF to have a reference;
      // repeating every 8s hitch the camera encode (WebRTC fps fell to 1–6
      // on the last run right as the blob went out).
      vmafTimer = window.setTimeout(() => {
        void flushVmafReference();
      }, 12_000);
    }
  } catch (err) {
    for (const session of whipSessions) {
      session.stop();
    }
    for (const session of sessions) {
      session.close();
    }
    capture.stop();
    throw err;
  }

  return {
    hasAudio: includeAudio,
    videoCodec,
    previewStream: capture.stream,
    draftByJobId,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      setLocIdrNudge(undefined);
      if (vmafTimer != null) {
        window.clearTimeout(vmafTimer);
        vmafTimer = null;
      }
      for (const encoder of encoders) {
        encoder.stop();
      }
      for (const session of sessions) {
        session.close();
      }
      for (const session of whipSessions) {
        session.stop();
      }
      capture.stop();
      void flushVmafReference();
    },
  };
}
