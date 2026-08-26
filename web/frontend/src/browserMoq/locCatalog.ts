/** LOC catalog the in-browser publisher advertises. The player FETCHes it. */

export const BROWSER_LOC_VIDEO_TRACK = "video";
export const BROWSER_LOC_AUDIO_TRACK = "audio";
export const BROWSER_LOC_VIDEO_CODEC = "avc1.4D4028";
export const BROWSER_LOC_AUDIO_CODEC = "opus";

export interface BrowserLocCatalogOptions {
  includeAudio: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
}

/** Playa knownTracks — subscribe to `video` in parallel with catalog FETCH. */
export function browserLocKnownTracks(options: BrowserLocCatalogOptions) {
  const videoCodec = options.videoCodec || BROWSER_LOC_VIDEO_CODEC;
  return {
    video: {
      name: BROWSER_LOC_VIDEO_TRACK,
      codec: videoCodec,
      width: options.width || 1280,
      height: options.height || 720,
    },
    ...(options.includeAudio
      ? {
          audio: {
            name: BROWSER_LOC_AUDIO_TRACK,
            codec: BROWSER_LOC_AUDIO_CODEC,
            samplerate: options.audioSampleRate || 48_000,
            channels: options.audioChannels || 2,
          },
        }
      : {}),
  };
}

export function browserLocCatalogTracks(options: BrowserLocCatalogOptions) {
  const width = options.width || 1280;
  const height = options.height || 720;
  const audioChannels = options.audioChannels || 2;
  const tracks: Array<{
    name: string;
    packaging: "loc";
    isLive: true;
    role: "video" | "audio";
    codec: string;
    width?: number;
    height?: number;
    bitrate: number;
    framerate?: number;
    samplerate?: number;
    channelConfig?: string;
    renderGroup: number;
  }> = [
    {
      name: BROWSER_LOC_VIDEO_TRACK,
      packaging: "loc",
      isLive: true,
      role: "video",
      codec: options.videoCodec || BROWSER_LOC_VIDEO_CODEC,
      width,
      height,
      bitrate: 2_500_000,
      framerate: 30,
      renderGroup: 1,
    },
  ];
  if (options.includeAudio) {
    tracks.push({
      name: BROWSER_LOC_AUDIO_TRACK,
      packaging: "loc",
      isLive: true,
      role: "audio",
      codec: BROWSER_LOC_AUDIO_CODEC,
      samplerate: options.audioSampleRate || 48_000,
      channelConfig: String(audioChannels),
      bitrate: 128_000,
      renderGroup: 1,
    });
  }
  return { tracks };
}
