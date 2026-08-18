import { BROWSER_LOC_AUDIO_CODEC } from "./locCatalog";

export interface BrowserAudioChunk {
  data: Uint8Array;
  timestampUs: number;
}

export interface BrowserAudioEncoder {
  start: () => Promise<void>;
  stop: () => void;
}

export function audioEncoderAvailable(): boolean {
  return typeof AudioEncoder !== "undefined";
}

export interface BrowserAudioLayout {
  sampleRate: number;
  channels: number;
}

export async function probeBrowserAudioEncoder(
  track: MediaStreamTrack,
): Promise<BrowserAudioLayout | null> {
  if (!audioEncoderAvailable()) {
    return null;
  }
  const settings = track.getSettings();
  const sampleRate = settings.sampleRate || 48_000;
  const channels = settings.channelCount || 1;
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: BROWSER_LOC_AUDIO_CODEC,
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    });
    if (support.supported) {
      return { sampleRate, channels };
    }
  } catch {
    // fall through
  }
  try {
    const fallback = await AudioEncoder.isConfigSupported({
      codec: BROWSER_LOC_AUDIO_CODEC,
      sampleRate: 48_000,
      numberOfChannels: 1,
      bitrate: 128_000,
    });
    if (fallback.supported) {
      return { sampleRate: 48_000, channels: 1 };
    }
  } catch {
    // unsupported
  }
  return null;
}

export function createBrowserAudioEncoder(
  track: MediaStreamTrack,
  onChunk: (chunk: BrowserAudioChunk) => void,
  layout: BrowserAudioLayout,
): BrowserAudioEncoder {
  let encoder: AudioEncoder | null = null;
  let processor: MediaStreamTrackProcessor<AudioData> | null = null;
  let reader: ReadableStreamDefaultReader<AudioData> | null = null;
  let running = false;

  async function pump() {
    if (!reader) {
      return;
    }
    while (running) {
      const { value, done } = await reader.read();
      if (done || !value) {
        break;
      }
      const data = value;
      try {
        if (encoder && encoder.state === "configured") {
          encoder.encode(data);
        }
      } finally {
        data.close();
      }
    }
  }

  return {
    async start() {
      encoder = new AudioEncoder({
        output(chunk) {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          onChunk({ data: bytes, timestampUs: chunk.timestamp });
        },
        error(err) {
          console.warn("browser MoQ audio encoder", err);
        },
      });
      await encoder.configure({
        codec: BROWSER_LOC_AUDIO_CODEC,
        sampleRate: layout.sampleRate,
        numberOfChannels: layout.channels,
        bitrate: 128_000,
      });
      processor = new MediaStreamTrackProcessor({ track });
      reader = processor.readable.getReader();
      running = true;
      void pump();
    },
    stop() {
      running = false;
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
