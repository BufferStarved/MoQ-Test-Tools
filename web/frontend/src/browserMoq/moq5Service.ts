import { encodeLocHeaders } from "@moqt/loc";
import { buildCatalog } from "@moqt/msf";
import { SubgroupIdMode, varint } from "@moqt/transport";
import { MoqtConnection } from "@moqt/webtransport";
import type { BrowserAudioChunk } from "./audioEncoder";
import type { BrowserVideoChunk } from "./encoder";
import {
  BROWSER_LOC_AUDIO_TRACK,
  BROWSER_LOC_CATALOG_GROUP,
  BROWSER_LOC_CATALOG_REFRESH_MS,
  BROWSER_LOC_CATALOG_TRACK,
  BROWSER_LOC_VIDEO_TRACK,
  browserLocCatalogTracks,
  browserLocHeaderOptions,
  browserLocPublishTrackNames,
  isPublishAccepted,
  locCatalogFetchEndLocation,
  locCatalogFetchShouldServe,
  locCatalogLargestLocation,
  locCatalogSubscribeParameters,
  locKeyframeVideoConfig,
  locIdrReplayGroup,
  locNextMediaGroup,
  locSubscriberLargestLocation,
  locVideoFetchEndLocation,
  locVideoFetchShouldServe,
  locVideoSubscribeParameters,
  resolvePublishOkWaiter,
} from "./locCatalog";
import type { MoqtDraftVersion } from "./moqtVersions";
import { openStrictMoqtWebTransport } from "./webTransport";

const DEFAULT_RELAY_DRAFT: MoqtDraftVersion = 18;

/**
 * In-browser MoQ5 / MOQT publish surface.
 *
 * Long-term this wraps libmoq (`moq::service` / `moq_media_sender_t`) compiled
 * to WASM. Until then, vendored @moqt/webtransport speaks the same drafts and
 * publishes LOC objects Playa can decode (not the ffmpeg/openmoq CMAF path).
 */
export interface Moq5PublishSession {
  namespace: string;
  draftVersion: MoqtDraftVersion;
  publishVideo: (chunk: BrowserVideoChunk) => void;
  publishAudio: (chunk: BrowserAudioChunk) => void;
  close: () => void;
}

async function fetchCertHash(fingerprintUrl: string): Promise<ArrayBuffer | undefined> {
  const response = await fetch(fingerprintUrl);
  if (!response.ok) {
    throw new Error(`MoQ TLS fingerprint unavailable (${response.status})`);
  }
  const hex = (await response.text()).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("MoQ TLS fingerprint from API is invalid.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function namespaceTuples(namespace: string): Uint8Array[] {
  return namespace
    .split("/")
    .filter(Boolean)
    .map((part) => new TextEncoder().encode(part));
}

async function openWebTransport(
  relayUrl: string,
  certHash: ArrayBuffer | undefined,
  draft: MoqtDraftVersion,
): Promise<WebTransport> {
  return openStrictMoqtWebTransport(relayUrl, certHash, draft);
}

function decodeTrackName(trackName: Uint8Array): string {
  return new TextDecoder().decode(trackName);
}

function draft18Opts(draft: MoqtDraftVersion): { firstObject: true } | Record<string, never> {
  return draft === 18 ? { firstObject: true } : {};
}

export async function connectMoq5WasmPublisher(options: {
  relayUrl: string;
  namespace: string;
  fingerprintUrl?: string;
  width: number;
  height: number;
  includeAudio: boolean;
  videoCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  draftVersion?: MoqtDraftVersion;
  onVideoSubscribed?: () => void;
}): Promise<Moq5PublishSession> {
  const draft = options.draftVersion ?? DEFAULT_RELAY_DRAFT;
  const certHash = options.fingerprintUrl ? await fetchCertHash(options.fingerprintUrl) : undefined;
  const catalogPayload = buildCatalog(
    browserLocCatalogTracks({
      includeAudio: options.includeAudio,
      width: options.width,
      height: options.height,
      videoCodec: options.videoCodec,
      audioSampleRate: options.audioSampleRate,
      audioChannels: options.audioChannels,
    }),
  );

  const transport = await openWebTransport(options.relayUrl, certHash, draft);
  try {
    return await bindPublisherSession({
      transport,
      draft,
      options,
      catalogPayload,
    });
  } catch (err) {
    try {
      transport.close();
    } catch {
      // already closed
    }
    const detail = err instanceof Error ? err.message : "WebTransport failed";
    throw new Error(`Relay did not accept MOQT draft-${draft}: ${detail}`);
  }
}

async function bindPublisherSession(args: {
  transport: WebTransport;
  draft: MoqtDraftVersion;
  options: {
    namespace: string;
    includeAudio: boolean;
    onVideoSubscribed?: () => void;
  };
  catalogPayload: Uint8Array;
}): Promise<Moq5PublishSession> {
  const { transport, draft, options, catalogPayload } = args;
  // Lock the wire format to the draft we offered. Auto-detect from
  // transport.protocol is how we previously stuck on a false moqt-18 ALPN.
  const connection = new MoqtConnection(draft);
  let nextAlias = 1n;
  let audioAlias = 0n;
  let audioReady = false;
  let videoGroupId = 0n;
  let haveVideoGroup = false;
  let audioGroupId = 0n;
  let haveAudioGroup = false;
  let lastDescription: Uint8Array | undefined;
  let lastIdr: { data: Uint8Array; extensions: Uint8Array; groupId: bigint } | null = null;
  let closed = false;
  let videoWrite: Promise<void> = Promise.resolve();
  const pendingVideo: BrowserVideoChunk[] = [];
  const sendQ: BrowserVideoChunk[] = [];
  let sending = false;
  const MAX_VIDEO_QUEUE = 45;
  // moqx forwards each SUBSCRIBE to the publisher (player + recorder, or a
  // player watchdog resubscribe overlapping the old session). A single
  // videoAlias meant the newest subscriber stole the track and the relay
  // RESET the abandoned streams (Resetstream code 3) — choppy playback and
  // a dead ingest recorder.
  type VideoSubscriber = {
    requestId: bigint;
    alias: bigint;
    streamId: bigint | null;
    objectId: bigint;
    permanent?: boolean;
  };
  const videoSubscribers: VideoSubscriber[] = [];
  const publishOkWaiters = new Map<bigint, (ok: boolean) => void>();
  const acceptedPublishIds = new Set<bigint>();
  const priorOnMessage = connection.onMessage;
  connection.onMessage = (message) => {
    priorOnMessage?.(message);
    const typed = message as { type?: string; requestId?: bigint };
    if (!isPublishAccepted(typed)) {
      return;
    }
    const matched = resolvePublishOkWaiter(typed.requestId, publishOkWaiters);
    if (matched) {
      publishOkWaiters.delete(matched.requestId);
      matched.waiter(true);
    } else if (typed.requestId != null) {
      acceptedPublishIds.add(typed.requestId);
    }
  };

  function waitPublishOk(requestId: bigint, timeoutMs = 4000): Promise<boolean> {
    if (acceptedPublishIds.has(requestId)) {
      acceptedPublishIds.delete(requestId);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        publishOkWaiters.delete(requestId);
        resolve(false);
      }, timeoutMs);
      publishOkWaiters.set(requestId, (ok) => {
        window.clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  const catalogAliases = new Set<bigint>();
  const catalogSubscribeIds = new Set<bigint>();
  const mediaSubscribeIds = new Set<bigint>();
  let catalogGroupId = BROWSER_LOC_CATALOG_GROUP;
  let catalogRefreshTimer: number | null = null;

  async function writeCatalogObject(alias: bigint, groupId = catalogGroupId): Promise<void> {
    const streamId = await connection.openSubgroup(alias, groupId, 0n, {
      hasExtensions: false,
      endOfGroup: true,
      defaultPriority: true,
      subgroupIdMode: SubgroupIdMode.ZERO,
      ...draft18Opts(draft),
    });
    await connection.sendObject(streamId, 0n, catalogPayload);
    await connection.closeSubgroup(streamId);
  }

  async function writeCatalogOnAliases(groupId = catalogGroupId): Promise<void> {
    for (const alias of catalogAliases) {
      try {
        await writeCatalogObject(alias, groupId);
      } catch (err) {
        console.warn("browser MoQ catalog write", err);
      }
    }
  }

  function startCatalogRefresh(): void {
    if (catalogRefreshTimer != null || closed) {
      return;
    }
    catalogRefreshTimer = window.setInterval(() => {
      if (closed || catalogAliases.size === 0) {
        return;
      }
      catalogGroupId += 1n;
      void writeCatalogOnAliases(catalogGroupId);
    }, BROWSER_LOC_CATALOG_REFRESH_MS);
  }

  async function publishCatalog(requestId: bigint, alias: bigint): Promise<void> {
    catalogAliases.add(alias);
    await connection.acceptSubscribe(requestId, alias, locCatalogSubscribeParameters(catalogGroupId));
    await writeCatalogObject(alias, catalogGroupId);
  }

  async function serveCatalogFetch(requestId: bigint): Promise<void> {
    let serveGroup = catalogGroupId;
    try {
      const range = connection.resolveJoiningFetch(requestId);
      serveGroup = range.startLocation.group;
    } catch {
      // Standalone FETCH or JOIN before SUBSCRIBE_OK saved a location.
    }
    // Exclusive one-past. {0,0} is an empty range (ca7bbb62 catalog-ready / 0 video).
    const endLocation = locCatalogFetchEndLocation(serveGroup);
    await connection.acceptFetch(requestId, { endLocation });
    const sid = await connection.openFetchStream(requestId);
    await connection.sendFetchObject(sid, {
      groupId: serveGroup,
      subgroupId: 0n,
      objectId: 0n,
      publisherPriority: 128,
      payload: catalogPayload,
    });
    await connection.closeFetchStream(sid);
  }

  function encodeVideoExtensions(chunk: BrowserVideoChunk): Uint8Array {
    const descriptionChanged =
      Boolean(chunk.description) &&
      (!lastDescription ||
        chunk.description!.byteLength !== lastDescription.byteLength ||
        chunk.description!.some((byte, i) => byte !== lastDescription![i]));
    if (chunk.description && (descriptionChanged || !lastDescription)) {
      lastDescription = chunk.description;
    }
    return encodeLocHeaders(
      {
        captureTimestamp: BigInt(Math.round(chunk.captureTimestampUs || Date.now() * 1000)),
        videoFrameMarking: {
          independent: chunk.isKeyframe,
          discardable: !chunk.isKeyframe,
          baseLayerSync: false,
          startOfFrame: true,
          endOfFrame: true,
          temporalId: 0,
        },
        ...(chunk.isKeyframe
          ? (() => {
              const videoConfig = locKeyframeVideoConfig(chunk.description, lastDescription);
              return videoConfig ? { videoConfig } : {};
            })()
          : {}),
      },
      browserLocHeaderOptions(draft),
    ) ?? new Uint8Array();
  }

  async function openVideoSubgroup(sub: VideoSubscriber, groupId: bigint): Promise<boolean> {
    if (sub.streamId !== null) {
      const old = sub.streamId;
      sub.streamId = null;
      void connection.closeSubgroup(old).catch(() => undefined);
    }
    sub.objectId = 0n;
    try {
      sub.streamId = await connection.openSubgroup(sub.alias, groupId, 0n, {
        hasExtensions: true,
        endOfGroup: true,
        publisherPriority: 128,
        ...draft18Opts(draft),
      });
      return true;
    } catch (err) {
      console.warn("browser MoQ open video subgroup", err);
      options.onVideoSubscribed?.();
      return false;
    }
  }

  async function sendLastIdrToSubscriber(sub: VideoSubscriber): Promise<void> {
    if (closed || !lastIdr) {
      return;
    }
    // Live pump already opened this alias — do not remap the GOP.
    if (sub.objectId > 0n || sub.streamId !== null) {
      return;
    }
    const groupId = locIdrReplayGroup(lastIdr.groupId);
    if (!(await openVideoSubgroup(sub, groupId))) {
      return;
    }
    try {
      await connection.sendObject(sub.streamId!, 0n, lastIdr.data, lastIdr.extensions);
      sub.objectId = 1n;
    } catch (err) {
      console.warn("browser MoQ send last IDR", err);
      sub.streamId = null;
    }
    // Keep the subgroup open so same-GOP P-frames attach on this alias.
  }

  async function serveVideoFetch(requestId: bigint): Promise<void> {
    if (!lastIdr) {
      void connection.rejectFetch(requestId, 0n, "video FETCH empty until first IDR").catch(() => undefined);
      return;
    }
    const groupId = lastIdr.groupId;
    await connection.acceptFetch(requestId, { endLocation: locVideoFetchEndLocation(groupId) });
    const sid = await connection.openFetchStream(requestId);
    await connection.sendFetchObject(sid, {
      groupId,
      subgroupId: 0n,
      objectId: 0n,
      publisherPriority: 128,
      payload: lastIdr.data,
    });
    await connection.closeFetchStream(sid);
  }

  async function sendVideoChunk(chunk: BrowserVideoChunk): Promise<void> {
    if (closed || videoSubscribers.length === 0) {
      return;
    }
    if (chunk.isKeyframe) {
      videoGroupId = locNextMediaGroup(videoGroupId, haveVideoGroup);
      haveVideoGroup = true;
    }
    const extensions = encodeVideoExtensions(chunk);
    if (chunk.isKeyframe) {
      lastIdr = { data: chunk.data, extensions, groupId: videoGroupId };
    }
    for (const sub of videoSubscribers) {
      if (chunk.isKeyframe) {
        if (!(await openVideoSubgroup(sub, videoGroupId))) {
          continue;
        }
      }
      if (sub.streamId === null) {
        continue;
      }
      try {
        await connection.sendObject(sub.streamId, sub.objectId, chunk.data, extensions);
        sub.objectId += 1n;
      } catch (err) {
        console.warn("browser MoQ send video object", err);
        sub.streamId = null;
      }
    }
  }

  function dropVideoSubscriber(requestId: bigint): void {
    const idx = videoSubscribers.findIndex((sub) => sub.requestId === requestId && !sub.permanent);
    if (idx < 0) {
      return;
    }
    const [sub] = videoSubscribers.splice(idx, 1);
    if (sub?.streamId != null) {
      void connection.closeSubgroup(sub.streamId).catch(() => undefined);
    }
  }

  function trimSendQueue() {
    if (sendQ.length <= MAX_VIDEO_QUEUE) {
      return;
    }
    let lastKey = -1;
    for (let i = sendQ.length - 1; i >= 0; i -= 1) {
      if (sendQ[i]?.isKeyframe) {
        lastKey = i;
        break;
      }
    }
    if (lastKey > 0) {
      sendQ.splice(0, lastKey);
    } else {
      sendQ.splice(0, sendQ.length - MAX_VIDEO_QUEUE);
    }
  }

  async function pumpVideo(): Promise<void> {
    if (sending) {
      return;
    }
    sending = true;
    try {
      while (!closed && sendQ.length > 0 && videoSubscribers.length > 0) {
        const chunk = sendQ.shift();
        if (!chunk) {
          break;
        }
        try {
          await sendVideoChunk(chunk);
        } catch (err) {
          console.warn("browser MoQ video object", err);
        }
      }
    } finally {
      sending = false;
      if (!closed && sendQ.length > 0 && videoSubscribers.length > 0) {
        void pumpVideo();
      }
    }
  }

  function enqueueVideo(chunk: BrowserVideoChunk): void {
    if (closed) {
      return;
    }
    if (chunk.description) {
      lastDescription = chunk.description;
    }
    if (videoSubscribers.length === 0) {
      if (chunk.isKeyframe) {
        pendingVideo.length = 0;
      }
      pendingVideo.push(chunk);
      if (pendingVideo.length > 90) {
        pendingVideo.splice(0, pendingVideo.length - 90);
      }
      return;
    }
    // Live edge only: a backed-up promise-per-frame chain used to deliver a
    // stale GOP while the player sat on a frozen canvas (recv still ~2.4 Mbps).
    if (chunk.isKeyframe) {
      sendQ.length = 0;
    }
    sendQ.push(chunk);
    trimSendQueue();
    void pumpVideo();
  }

  function flushPendingVideo(): void {
    const queued = pendingVideo.splice(0, pendingVideo.length);
    for (const chunk of queued) {
      enqueueVideo(chunk);
    }
  }

  connection.onSubscribe = (requestId, _ns, trackName) => {
    const name = decodeTrackName(trackName);
    const alias = nextAlias;
    nextAlias += 1n;
    if (name === "catalog" || name === BROWSER_LOC_CATALOG_TRACK) {
      catalogSubscribeIds.add(requestId);
      void publishCatalog(requestId, alias).catch((err) => {
        console.warn("browser MoQ catalog publish", err);
      });
      return;
    }
    if (name === BROWSER_LOC_VIDEO_TRACK) {
      mediaSubscribeIds.add(requestId);
      const subscriber: VideoSubscriber = {
        requestId,
        alias,
        streamId: null,
        objectId: 0n,
      };
      videoSubscribers.push(subscriber);
      const largest = lastIdr
        ? { group: lastIdr.groupId, object: 0n }
        : locSubscriberLargestLocation(videoGroupId, 0n);
      void connection
        .acceptSubscribe(requestId, alias, locVideoSubscribeParameters(largest))
        .then(async () => {
          // moqx drops the subscriber if beginSubgroup races SUBSCRIBE_OK
          // (`Failed to create uni stream` on bench-24c990ee/audio).
          await new Promise((resolve) => window.setTimeout(resolve, 50));
          if (closed || !videoSubscribers.includes(subscriber)) {
            return;
          }
          // 8aeaa2e4: LargestObject on an empty alias never attached later
          // GOPs. Send the cached IDR on THIS subscribe before live deltas.
          await sendLastIdrToSubscriber(subscriber);
          options.onVideoSubscribed?.();
          flushPendingVideo();
        })
        .catch((err) => {
          dropVideoSubscriber(requestId);
          console.warn("browser MoQ accept video", err);
        });
      return;
    }
    if (name === BROWSER_LOC_AUDIO_TRACK && options.includeAudio) {
      mediaSubscribeIds.add(requestId);
      audioAlias = alias;
      void connection
        .acceptSubscribe(requestId, alias)
        .then(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
          if (!closed) {
            audioReady = true;
          }
        })
        .catch((err) => {
          console.warn("browser MoQ accept audio", err);
        });
      return;
    }
    void connection.rejectSubscribe(requestId, 0n, `Unknown track: ${name}`).catch(() => undefined);
  };

  connection.onSubscribeClosed = (requestId) => {
    dropVideoSubscriber(requestId);
  };

  connection.onFetch = (requestId, fetchMsg) => {
    const standalone = fetchMsg.fetch.fetchType === 0x1 ? fetchMsg.fetch : null;
    const name = standalone ? decodeTrackName(standalone.trackName) : null;
    const joiningId =
      fetchMsg.fetch.fetchType === 0x2 || fetchMsg.fetch.fetchType === 0x3
        ? fetchMsg.fetch.joiningRequestId
        : null;
    const serveCatalog = locCatalogFetchShouldServe({
      trackName: name,
      joiningRequestId: joiningId,
      catalogSubscribeIds,
      mediaSubscribeIds,
      liveCatalogWritten: draft === 18,
    });
    if (serveCatalog) {
      void serveCatalogFetch(requestId).catch((err) => {
        console.warn("browser MoQ catalog FETCH", err);
      });
      return;
    }
    if (
      locVideoFetchShouldServe({
        trackName: name,
        joiningRequestId: joiningId,
        mediaSubscribeIds,
      })
    ) {
      void serveVideoFetch(requestId).catch((err) => {
        console.warn("browser MoQ video FETCH", err);
      });
      return;
    }
    void connection.rejectFetch(requestId, 0n, "FETCH only served for catalog or video").catch(() => undefined);
  };

  connection.setLargestLocationProvider((requestId) => {
    if (catalogSubscribeIds.has(requestId)) {
      return locCatalogLargestLocation(catalogGroupId);
    }
    const video = videoSubscribers.find((sub) => sub.requestId === requestId);
    if (video) {
      return locSubscriberLargestLocation(videoGroupId, video.objectId);
    }
    return lastIdr ? { group: lastIdr.groupId, object: 0n } : null;
  });

  await connection.connect(transport, { maxRequestId: varint(100) });
  if (connection.draftVersion !== draft) {
    throw new Error(`MOQT SETUP negotiated draft-${connection.draftVersion}, expected draft-${draft}`);
  }
  const tuples = namespaceTuples(options.namespace);
  const ns = tuples.length ? tuples : [new TextEncoder().encode(options.namespace)];
  const nsRequestId = await connection.publishNamespace(ns);
  await waitPublishOk(nsRequestId);

  // draft-18 live-write (openmoq publish_tracks). Relays serve FETCH /
  // SUBSCRIBE from these aliases. Waiting for forwarded onSubscribe left
  // east with no catalog and linode catalog-ready / 0 video frames.
  if (draft === 18) {
    const encoder = new TextEncoder();
    for (const trackName of browserLocPublishTrackNames({ includeAudio: options.includeAudio })) {
      const alias = nextAlias;
      nextAlias += 1n;
      const requestId = await connection.publish(ns, encoder.encode(trackName), alias);
      await waitPublishOk(requestId);
      if (trackName === BROWSER_LOC_CATALOG_TRACK) {
        catalogAliases.add(alias);
        try {
          await writeCatalogObject(alias, catalogGroupId);
        } catch (err) {
          console.warn("browser MoQ live catalog", err);
        }
        startCatalogRefresh();
      } else if (trackName === BROWSER_LOC_VIDEO_TRACK) {
        videoSubscribers.push({
          requestId,
          alias,
          streamId: null,
          objectId: 0n,
          permanent: true,
        });
        options.onVideoSubscribed?.();
      }
    }
  }

  return {
    namespace: options.namespace,
    draftVersion: draft,
    publishVideo(chunk) {
      if (closed) {
        return;
      }
      enqueueVideo(chunk);
    },
    publishAudio(chunk) {
      if (closed || !audioReady || audioAlias === 0n) {
        return;
      }
      videoWrite = videoWrite
        .then(async () => {
          if (closed || !audioReady) {
            return;
          }
          audioGroupId = locNextMediaGroup(audioGroupId, haveAudioGroup);
          haveAudioGroup = true;
          const extensions = encodeLocHeaders(
            { captureTimestamp: BigInt(Math.round(chunk.timestampUs)) },
            browserLocHeaderOptions(draft),
          );
          const streamId = await connection.openSubgroup(audioAlias, audioGroupId, 0n, {
            hasExtensions: true,
            endOfGroup: true,
            publisherPriority: 64,
            ...draft18Opts(draft),
          });
          await connection.sendObject(streamId, 0n, chunk.data, extensions);
          await connection.closeSubgroup(streamId);
        })
        .catch((err) => {
          console.warn("browser MoQ audio object", err);
        });
    },
    close() {
      closed = true;
      if (catalogRefreshTimer != null) {
        window.clearInterval(catalogRefreshTimer);
        catalogRefreshTimer = null;
      }
      try {
        void connection.close();
      } catch {
        // already closed
      }
      try {
        transport.close();
      } catch {
        // already closed
      }
    },
  };
}
