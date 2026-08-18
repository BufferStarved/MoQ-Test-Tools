import { postEncodeSample, postPublisherReady, uploadVmafReference } from "../api";
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

export interface BrowserMoqLeg {
  jobId: string;
  protocol?: "moq" | "webrtc";
  relayUrl?: string;
  namespace?: string;
  fingerprintUrl?: string;
  whipUrl?: string;
  ingestVmaf?: boolean;
}

export interface BrowserMoqRun {
  hasAudio: boolean;
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
      whipSessions.push(
        await startWhipPublish({
          stream: capture.stream,
          whipUrl: leg.whipUrl,
          jobId: leg.jobId,
        }),
      );
    }

    const moqResults = await Promise.allSettled(
      moqLegs.map(async (leg) => {
        const session = await connectMoq5WasmPublisher({
          relayUrl: leg.relayUrl || "",
          namespace: leg.namespace || "benchmark",
          fingerprintUrl: leg.fingerprintUrl,
          width,
          height,
          includeAudio,
          videoCodec,
          onVideoSubscribed: () => requestKeyframe(),
        });
        await postPublisherReady(leg.jobId);
        return { leg, session };
      }),
    );
    const moqErrors: string[] = [];
    for (const result of moqResults) {
      if (result.status === "fulfilled") {
        sessions.push(result.value.session);
        draftByJobId[result.value.leg.jobId] = result.value.session.draftVersion;
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        moqErrors.push(reason);
      }
    }
    if (moqLegs.length > 0 && sessions.length === 0) {
      throw new Error(moqErrors[0] || "Browser MoQ publish failed on every relay.");
    }
    if (moqErrors.length) {
      console.warn("Some MoQ relays did not accept this publish:", moqErrors.join(" | "));
    }


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
        },
        (sample) => {
          if (stopped) {
            return;
          }
          for (const leg of moqLegs) {
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
      await encoder.start();
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
    previewStream: capture.stream,
    draftByJobId,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
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
