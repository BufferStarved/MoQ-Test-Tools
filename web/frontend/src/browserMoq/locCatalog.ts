/** LOC catalog the in-browser publisher advertises. The player FETCHes it. */

import { MessageParam, type Parameters } from "@moqt/transport";

export const BROWSER_LOC_CATALOG_TRACK = "catalog";
export const BROWSER_LOC_VIDEO_TRACK = "video";
export const BROWSER_LOC_AUDIO_TRACK = "audio";
export const BROWSER_LOC_VIDEO_CODEC = "avc1.4D4028";
export const BROWSER_LOC_AUDIO_CODEC = "opus";
/** Live-write group so CatalogBootstrap Joining FETCH(offset 0) hits object 0. */
export const BROWSER_LOC_CATALOG_GROUP = 0n;
export const BROWSER_LOC_CATALOG_OBJECT = 0n;
/** Rewrite the live catalog so empty-wait / late JOIN can still converge. */
export const BROWSER_LOC_CATALOG_REFRESH_MS = 2_000;

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

/** Snapshot advertised in SUBSCRIBE_OK so Joining FETCH can resolve. */
export function locCatalogLargestLocation(groupId: bigint = BROWSER_LOC_CATALOG_GROUP): {
  group: bigint;
  object: bigint;
} {
  return { group: groupId, object: BROWSER_LOC_CATALOG_OBJECT };
}

/**
 * FETCH_OK End Location is exclusive one-past (§9.16.3 / d18 §10.13).
 * `{group:0, object:0}` is an empty range — that was catalog-ready / 0 video.
 */
export function locCatalogFetchEndLocation(groupId: bigint = BROWSER_LOC_CATALOG_GROUP): {
  group: bigint;
  object: bigint;
} {
  return { group: groupId, object: BROWSER_LOC_CATALOG_OBJECT + 1n };
}

/** draft-18 SUBSCRIBE_OK LARGEST_OBJECT so CatalogBootstrap can Joining FETCH. */
export function locCatalogSubscribeParameters(groupId: bigint = BROWSER_LOC_CATALOG_GROUP): {
  parameters: Parameters;
} {
  return {
    parameters: new Map([
      [MessageParam.LARGEST_OBJECT as bigint, [locCatalogLargestLocation(groupId)]],
    ]),
  };
}

/**
 * CatalogBootstrap: standalone FETCH(name=catalog) or Joining FETCH on the
 * catalog SUBSCRIBE. Live-write already put object 0/0 on the wire — serve
 * a joining FETCH that races the forwarded SUBSCRIBE instead of rejecting.
 * Do not serve a video/audio Joining FETCH as catalog JSON.
 */
export function locCatalogFetchShouldServe(args: {
  trackName?: string | null;
  joiningRequestId?: bigint | null;
  catalogSubscribeIds?: ReadonlySet<bigint>;
  mediaSubscribeIds?: ReadonlySet<bigint>;
  liveCatalogWritten?: boolean;
}): boolean {
  if (args.trackName === BROWSER_LOC_VIDEO_TRACK || args.trackName === BROWSER_LOC_AUDIO_TRACK) {
    return false;
  }
  if (args.trackName === BROWSER_LOC_CATALOG_TRACK) {
    return true;
  }
  const joiningId = args.joiningRequestId;
  if (joiningId == null) {
    return false;
  }
  if (args.mediaSubscribeIds?.has(joiningId)) {
    return false;
  }
  if (args.catalogSubscribeIds?.has(joiningId)) {
    return true;
  }
  return Boolean(args.liveCatalogWritten);
}

/**
 * First video object. 8aeaa2e4 catalog-ready / rendered=0: playa issued
 * SUBSCRIBE video and the publisher rejected FETCH, so LargestObject sat
 * on an empty track. Serve the last IDR — do not send catalog JSON.
 */
export function locVideoFetchShouldServe(args: {
  trackName?: string | null;
  joiningRequestId?: bigint | null;
  mediaSubscribeIds?: ReadonlySet<bigint>;
}): boolean {
  if (args.trackName === BROWSER_LOC_VIDEO_TRACK) {
    return true;
  }
  if (args.trackName === BROWSER_LOC_CATALOG_TRACK || args.trackName === BROWSER_LOC_AUDIO_TRACK) {
    return false;
  }
  const joiningId = args.joiningRequestId;
  if (joiningId == null) {
    return false;
  }
  return Boolean(args.mediaSubscribeIds?.has(joiningId));
}

/** Exclusive one-past for a one-object IDR group. */
export function locVideoFetchEndLocation(groupId: bigint): {
  group: bigint;
  object: bigint;
} {
  return { group: groupId, object: 1n };
}

/**
 * SUBSCRIBE_OK LARGEST_OBJECT for a subscriber that has actually sent.
 * A phantom {Date.now(), 0} was 8aeaa2e4: LargestObject waited past a
 * location that never existed on this alias (and overflowed uint32 on moqx).
 */
export function locSubscriberLargestLocation(
  groupId: bigint,
  nextObjectId: bigint,
): { group: bigint; object: bigint } | null {
  if (nextObjectId <= 0n) {
    return null;
  }
  return { group: groupId, object: nextObjectId - 1n };
}

export function locVideoSubscribeParameters(
  location: { group: bigint; object: bigint } | null,
): { parameters?: Parameters } {
  if (!location) {
    return {};
  }
  return {
    parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [location]]]),
  };
}

/** Sequential GOP ids. Date.now() (~1.7e12) is above uint32 and was dropped. */
export function locNextMediaGroup(current: bigint, haveGroup: boolean): bigint {
  return haveGroup ? current + 1n : 0n;
}

/**
 * Cached IDR must land on the group SUBSCRIBE_OK advertised.
 * 4869f0c called locNextMediaGroup() here: LargestObject {X,0} on the
 * wire, objects on {X+1} — moqx never attached (9e0a507e rendered=0).
 */
export function locIdrReplayGroup(advertisedGroupId: bigint): bigint {
  return advertisedGroupId;
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
