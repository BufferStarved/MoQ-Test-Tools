import { avcChunkIsSyncPoint } from "./h264AnnexB";
import { BROWSER_LOC_VIDEO_CODEC } from "./locCatalog";

export interface BrowserEncodeSample {
  elapsedSec: number;
  encodedBitrateKbps: number;
  fps: number;
  encodeLagMs: number;
}

/** Capture→encoded plus WebCodecs queue. VideoFrame.timestamp is not wall. */
export function browserEncodeLagMs(options: {
  captureTimestampUs: number;
  encodedAtMs?: number;
  encodeQueueSize?: number;
  fps?: number;
}): number {
  const encodedAt = options.encodedAtMs ?? Date.now();
  const captureMs = options.captureTimestampUs / 1000;
  const captureLag =
    Number.isFinite(captureMs) && captureMs > 0 ? Math.max(0, encodedAt - captureMs) : 0;
  const fps = options.fps && options.fps > 0 ? options.fps : 30;
  const queueLag = Math.max(0, options.encodeQueueSize ?? 0) * (1000 / fps);
  return Math.round(Math.min(30_000, Math.max(captureLag, queueLag)));
}

export interface BrowserVideoChunk {
  data: Uint8Array;
  isKeyframe: boolean;
  timestampUs: number;
  /** Unix-epoch microseconds at camera capture — LOC CaptureTimestamp. */
  captureTimestampUs: number;
  description?: Uint8Array;
}

export interface BrowserEncoder {
  width: number;
  height: number;
  start: () => Promise<void>;
  requestKeyframe: () => void;
  stop: () => void;
}

/** 0.5s GOP at 30 fps. A missing IDR used to leave one open MoQ group until Playa froze (~9s). */
const KEYFRAME_INTERVAL = 15;

/**
 * Hardware H.264 encode in-page. Chunks are published as LOC objects —
 * ffmpeg never runs.
 */
export async function pickBrowserVideoCodec(): Promise<string> {
  const candidates = [BROWSER_LOC_VIDEO_CODEC, "avc1.42001f", "avc1.4D401F"];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: 1280,
        height: 720,
        bitrate: 2_500_000,
        framerate: 30,
      });
      if (support.supported) {
        return codec;
      }
    } catch {
      // try the next hardware-friendly profile
    }
  }
  return BROWSER_LOC_VIDEO_CODEC;
}

export function createBrowserVideoEncoder(
  track: MediaStreamTrack,
  onChunk: (chunk: BrowserVideoChunk) => void,
  onSample: (sample: BrowserEncodeSample) => void,
  codec: string = BROWSER_LOC_VIDEO_CODEC,
): BrowserEncoder {
  let encoder: VideoEncoder | null = null;
  let processor: MediaStreamTrackProcessor<VideoFrame> | null = null;
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  // MediaStreamTrackProcessor takes exclusive access of the given track in
  // Chrome. Cloning keeps the live camera on RTCPeerConnection / <video>
  // preview (comparison CSV: WHIP bitrate collapsed from ~600 kbps to ~30
  // kbps the moment WebCodecs started, with 23–70s encode lag).
  let encodeTrack: MediaStreamTrack | null = null;
  let running = false;
  let startedAt = 0;
  let bytesWindow = 0;
  let framesWindow = 0;
  let windowStarted = 0;
  let lastFrameAt = 0;
  let lastEncodeLagMs = 0;
  const pendingCaptureUs: number[] = [];
  let sampleTimer: number | null = null;
  let frameCount = 0;
  let forceKeyframe = true;
  let awaitingIdr = false;
  let lastIdrAt = 0;
  const settings = track.getSettings();
  const width = settings.width || 1280;
  const height = settings.height || 720;

  async function pump() {
    if (!reader) {
      return;
    }
    while (running) {
      const { value, done } = await reader.read();
      if (done || !value) {
        break;
      }
      const frame = value;
      try {
        if (!encoder || encoder.state !== "configured") {
          continue;
        }
        const idrStale = lastIdrAt === 0 || performance.now() - lastIdrAt > 800;
        const key =
          forceKeyframe || awaitingIdr || idrStale || frameCount % KEYFRAME_INTERVAL === 0;
        forceKeyframe = false;
        pendingCaptureUs.push(Math.round(Date.now() * 1000));
        encoder.encode(frame, { keyFrame: key });
        frameCount += 1;
        framesWindow += 1;
        lastFrameAt = performance.now();
        lastEncodeLagMs = browserEncodeLagMs({
          captureTimestampUs: pendingCaptureUs[pendingCaptureUs.length - 1] ?? 0,
          encodeQueueSize: encoder.encodeQueueSize,
          fps: 30,
        });
      } finally {
        frame.close();
      }
    }
  }

  return {
    width,
    height,
    async start() {
      encoder = new VideoEncoder({
        output(chunk, meta) {
          const captureUs = pendingCaptureUs[0] ?? Math.round(Date.now() * 1000);
          lastEncodeLagMs = browserEncodeLagMs({
            captureTimestampUs: captureUs,
            encodeQueueSize: encoder?.encodeQueueSize ?? 0,
            fps: 30,
          });
          bytesWindow += chunk.byteLength;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          let description: Uint8Array | undefined;
          const raw = meta?.decoderConfig?.description;
          if (raw) {
            if (raw instanceof ArrayBuffer) {
              description = new Uint8Array(raw);
            } else if (ArrayBuffer.isView(raw)) {
              description = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
            }
          }
          const isKeyframe = chunk.type === "key" || avcChunkIsSyncPoint(data);
          if (isKeyframe) {
            lastIdrAt = performance.now();
            awaitingIdr = false;
          } else {
            // Keep requesting until the bitstream actually has an IDR. Some
            // hardware encoders ignore keyFrame after the first group.
            awaitingIdr =
              awaitingIdr || frameCount <= 1 || frameCount % KEYFRAME_INTERVAL === 0;
          }
          onChunk({
            data,
            isKeyframe,
            timestampUs: chunk.timestamp,
            captureTimestampUs: pendingCaptureUs.shift() ?? Math.round(Date.now() * 1000),
            description,
          });
        },
        error(err) {
          console.warn("browser MoQ encoder", err);
        },
      });
      // Hardware often ignores keyFrame after the first IDR, leaving one
      // open MoQ group. Prefer software so GOP boundaries actually exist.
      let acceleration: HardwareAcceleration = "no-preference";
      try {
        const soft = await VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          bitrate: 2_500_000,
          framerate: 30,
          latencyMode: "realtime",
          avc: { format: "avc" },
          hardwareAcceleration: "prefer-software",
        });
        if (soft.supported) {
          acceleration = "prefer-software";
        }
      } catch {
        // keep hardware / no-preference
      }
      await encoder.configure({
        codec,
        width,
        height,
        bitrate: 2_500_000,
        framerate: 30,
        latencyMode: "realtime",
        avc: { format: "avc" },
        hardwareAcceleration: acceleration,
      });
      encodeTrack = typeof track.clone === "function" ? track.clone() : track;
      processor = new MediaStreamTrackProcessor({ track: encodeTrack });
      reader = processor.readable.getReader();
      running = true;
      startedAt = performance.now();
      windowStarted = startedAt;
      void pump();
      sampleTimer = window.setInterval(() => {
        if (!running) {
          return;
        }
        const now = performance.now();
        const windowSec = Math.max(0.2, (now - windowStarted) / 1000);
        onSample({
          elapsedSec: Math.max(0, Math.round((now - startedAt) / 1000)),
          encodedBitrateKbps: (bytesWindow * 8) / windowSec / 1000,
          fps: framesWindow / windowSec,
          encodeLagMs: lastEncodeLagMs,
        });
        bytesWindow = 0;
        framesWindow = 0;
        windowStarted = now;
      }, 1000);
    },
    requestKeyframe() {
      forceKeyframe = true;
      awaitingIdr = true;
    },
    stop() {
      running = false;
      if (sampleTimer != null) {
        window.clearInterval(sampleTimer);
        sampleTimer = null;
      }
      void reader?.cancel();
      reader = null;
      processor = null;
      if (encodeTrack && encodeTrack !== track) {
        try {
          encodeTrack.stop();
        } catch {
          // already ended
        }
      }
      encodeTrack = null;
      if (encoder && encoder.state !== "closed") {
        try {
          encoder.close();
        } catch {
          // already closed
        }
      }
      encoder = null;
    },
  };
}
