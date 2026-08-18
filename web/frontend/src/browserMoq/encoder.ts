import { BROWSER_LOC_VIDEO_CODEC } from "./locCatalog";

export interface BrowserEncodeSample {
  elapsedSec: number;
  encodedBitrateKbps: number;
  fps: number;
  encodeLagMs: number;
}

export interface BrowserVideoChunk {
  data: Uint8Array;
  isKeyframe: boolean;
  timestampUs: number;
  description?: Uint8Array;
}

export interface BrowserEncoder {
  width: number;
  height: number;
  start: () => Promise<void>;
  requestKeyframe: () => void;
  stop: () => void;
}

/** 1s GOP at 30 fps — LargestObject still prefers an IDR; shorter GOPs used to skip under WT contention. */
const KEYFRAME_INTERVAL = 30;

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
  let running = false;
  let startedAt = 0;
  let bytesWindow = 0;
  let framesWindow = 0;
  let windowStarted = 0;
  let lastFrameAt = 0;
  let sampleTimer: number | null = null;
  let frameCount = 0;
  let forceKeyframe = true;
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
        const key = forceKeyframe || frameCount % KEYFRAME_INTERVAL === 0;
        forceKeyframe = false;
        encoder.encode(frame, { keyFrame: key });
        frameCount += 1;
        framesWindow += 1;
        lastFrameAt = performance.now();
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
          onChunk({
            data,
            isKeyframe: chunk.type === "key",
            // WebCodecs media timeline (µs). Playa render is relative to the
            // first frame; Unix-epoch stamps are not required for decode.
            timestampUs: chunk.timestamp,
            description,
          });
        },
        error(err) {
          console.warn("browser MoQ encoder", err);
        },
      });
      await encoder.configure({
        codec,
        width,
        height,
        bitrate: 2_500_000,
        framerate: 30,
        latencyMode: "realtime",
        avc: { format: "avc" },
      });
      processor = new MediaStreamTrackProcessor({ track });
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
          encodeLagMs: lastFrameAt ? Math.max(0, now - lastFrameAt) : 0,
        });
        bytesWindow = 0;
        framesWindow = 0;
        windowStarted = now;
      }, 1000);
    },
    requestKeyframe() {
      forceKeyframe = true;
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
