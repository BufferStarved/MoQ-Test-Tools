/** LOC catalog the in-browser publisher advertises. The player FETCHes it. */

export const BROWSER_LOC_CATALOG_TRACK = "catalog";
export const BROWSER_LOC_VIDEO_TRACK = "video";
export const BROWSER_LOC_AUDIO_TRACK = "audio";
export const BROWSER_LOC_VIDEO_CODEC = "avc1.4D4028";
export const BROWSER_LOC_AUDIO_CODEC = "opus";
/** Live-write group so CatalogBootstrap Joining FETCH(offset 0) hits object 0. */
export const BROWSER_LOC_CATALOG_GROUP = 0n;

/**
 * Draft-18 LOC uses vi64. The draft-16 delta flag stays on QUIC
 * varint and mis-encodes every value ≥ 64 — playa then drops the objects.
 */
export function browserLocHeaderOptions(draft: number): {
  wireProfile: "d16-delta-varint" | "d18-delta-vi64";
} {
  return { wireProfile: draft === 18 ? "d18-delta-vi64" : "d16-delta-varint" };
}

/** Retained catalog must stay fetchable. Ending it breaks MSF-01 Joining FETCH. */
export function locCatalogTrackShouldEnd(): boolean {
  return false;
}

export function isPublishAccepted(
  message: { type?: string; requestId?: bigint } | null | undefined,
  requestId?: bigint,
): boolean {
  if (!message || (message.type !== "REQUEST_OK" && message.type !== "PUBLISH_OK")) {
    return false;
  }
  // draft-18 REQUEST_OK rides the request stream and often omits requestId.
  return requestId == null || message.requestId == null || message.requestId === requestId;
}

/**
 * Correlate an inbound REQUEST_OK to a pending PUBLISH / PUBLISH_NAMESPACE.
 * When the wire omits requestId, take the oldest waiter (we publish serially).
 * A stamped id that we did not send must not steal another waiter.
 */
export function resolvePublishOkWaiter<T>(
  messageRequestId: bigint | undefined,
  waiters: Map<bigint, T>,
): { requestId: bigint; waiter: T } | undefined {
  if (messageRequestId != null) {
    const waiter = waiters.get(messageRequestId);
    return waiter ? { requestId: messageRequestId, waiter } : undefined;
  }
  const firstId = waiters.keys().next().value;
  if (firstId == null) {
    return undefined;
  }
  const waiter = waiters.get(firstId);
  return waiter ? { requestId: firstId, waiter } : undefined;
}

/**
 * CatalogBootstrap: standalone FETCH(name=catalog) or Joining FETCH on the
 * catalog SUBSCRIBE. Live-write already put object 0/0 on the wire — serve
 * a joining FETCH that races the forwarded SUBSCRIBE instead of rejecting.
 */
export function locCatalogFetchShouldServe(args: {
  trackName?: string | null;
  joiningRequestId?: bigint | null;
  catalogSubscribeIds?: ReadonlySet<bigint>;
  liveCatalogWritten?: boolean;
}): boolean {
  if (args.trackName === BROWSER_LOC_CATALOG_TRACK) {
    return true;
  }
  const joiningId = args.joiningRequestId;
  if (joiningId == null) {
    return false;
  }
  if (args.catalogSubscribeIds?.has(joiningId)) {
    return true;
  }
  return Boolean(args.liveCatalogWritten);
}

/**
 * avcC on every IDR. Playa configures WebCodecs from LOC VideoConfig, not
 * from an injected catalog initData (9958d69). Missing description = 0 frames.
 */
export function locKeyframeVideoConfig(
  description: Uint8Array | undefined,
  lastDescription: Uint8Array | undefined,
): Uint8Array | undefined {
  if (description && description.byteLength > 0) {
    return description;
  }
  if (lastDescription && lastDescription.byteLength > 0) {
    return lastDescription;
  }
  return undefined;
}

/** Tracks live-PUBLISHed after announce (same idea as libmoq publish_tracks). */
export function browserLocPublishTrackNames(options: { includeAudio: boolean }): string[] {
  return [
    BROWSER_LOC_CATALOG_TRACK,
    BROWSER_LOC_VIDEO_TRACK,
    ...(options.includeAudio ? [BROWSER_LOC_AUDIO_TRACK] : []),
  ];
}

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
