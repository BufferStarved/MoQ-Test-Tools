import { encodeLocHeaders } from "@moqt/loc";
import { buildCatalog } from "@moqt/msf";
import { PublishDoneCode, SubgroupIdMode, varint } from "@moqt/transport";
import { MoqtConnection } from "@moqt/webtransport";
import type { BrowserAudioChunk } from "./audioEncoder";
import type { BrowserVideoChunk } from "./encoder";
import {
  BROWSER_LOC_AUDIO_TRACK,
  BROWSER_LOC_VIDEO_TRACK,
  browserLocCatalogTracks,
} from "./locCatalog";
import type { MoqtDraftVersion } from "./moqtVersions";
import { openStrictMoqtWebTransport } from "./webTransport";

const RELAY_DRAFT: MoqtDraftVersion = 18;

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
  onVideoSubscribed?: () => void;
}): Promise<Moq5PublishSession> {
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

  const transport = await openWebTransport(options.relayUrl, certHash, RELAY_DRAFT);
  try {
    return await bindPublisherSession({
      transport,
      draft: RELAY_DRAFT,
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
    throw new Error(`Relay did not accept MOQT draft-18: ${detail}`);
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
  let videoGroupId = BigInt(Date.now());
  let audioGroupId = videoGroupId + 1_000_000n;
  let lastDescription: Uint8Array | undefined;
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
  };
  const videoSubscribers: VideoSubscriber[] = [];

  async function publishCatalog(requestId: bigint, alias: bigint): Promise<void> {
    await connection.acceptSubscribe(requestId, alias);
    const catalogGroupId = BigInt(Date.now());
    const streamId = await connection.openSubgroup(alias, catalogGroupId, 0n, {
      hasExtensions: false,
      endOfGroup: true,
      defaultPriority: true,
      subgroupIdMode: SubgroupIdMode.ZERO,
      ...draft18Opts(draft),
    });
    await connection.sendObject(streamId, 0n, catalogPayload);
    await connection.closeSubgroup(streamId);
    await connection.publishDone(requestId, PublishDoneCode.TRACK_ENDED, "");
  }

  async function sendVideoChunk(chunk: BrowserVideoChunk): Promise<void> {
    if (closed || videoSubscribers.length === 0) {
      return;
    }
    if (chunk.isKeyframe) {
      videoGroupId += 1n;
    }
    const descriptionChanged =
      Boolean(chunk.description) &&
      (!lastDescription ||
        chunk.description!.byteLength !== lastDescription.byteLength ||
        chunk.description!.some((byte, i) => byte !== lastDescription![i]));
    if (chunk.description && (descriptionChanged || !lastDescription)) {
      lastDescription = chunk.description;
    }
    const extensions = encodeLocHeaders(
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
        ...(chunk.isKeyframe && lastDescription ? { videoConfig: lastDescription } : {}),
      },
      { deltaEncoded: true },
    );
    for (const sub of videoSubscribers) {
      if (chunk.isKeyframe) {
        if (sub.streamId !== null) {
          const old = sub.streamId;
          sub.streamId = null;
          // Do not await — a hung close on one subscriber used to stall the
          // shared encode write chain for every relay.
          void connection.closeSubgroup(old).catch(() => undefined);
        }
        sub.objectId = 0n;
        try {
          sub.streamId = await connection.openSubgroup(sub.alias, videoGroupId, 0n, {
            hasExtensions: true,
            endOfGroup: true,
            publisherPriority: 128,
            ...draft18Opts(draft),
          });
        } catch (err) {
          console.warn("browser MoQ open video subgroup", err);
          options.onVideoSubscribed?.();
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
    const idx = videoSubscribers.findIndex((sub) => sub.requestId === requestId);
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
    if (name === "catalog") {
      void publishCatalog(requestId, alias).catch((err) => {
        console.warn("browser MoQ catalog publish", err);
      });
      return;
    }
    if (name === BROWSER_LOC_VIDEO_TRACK) {
      const subscriber: VideoSubscriber = {
        requestId,
        alias,
        streamId: null,
        objectId: 0n,
      };
      videoSubscribers.push(subscriber);
      void connection
        .acceptSubscribe(requestId, alias)
        .then(async () => {
          // moqx drops the subscriber if beginSubgroup races SUBSCRIBE_OK
          // (`Failed to create uni stream` on bench-24c990ee/audio).
          await new Promise((resolve) => window.setTimeout(resolve, 50));
          if (closed || !videoSubscribers.includes(subscriber)) {
            return;
          }
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

  await connection.connect(transport, { maxRequestId: varint(100) });
  if (connection.draftVersion !== draft) {
    throw new Error(`MOQT SETUP negotiated draft-${connection.draftVersion}, expected draft-${draft}`);
  }
  const tuples = namespaceTuples(options.namespace);
  await connection.publishNamespace(tuples.length ? tuples : [new TextEncoder().encode(options.namespace)]);

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
          audioGroupId += 1n;
          const extensions = encodeLocHeaders(
            { captureTimestamp: BigInt(Math.round(chunk.timestampUs)) },
            { deltaEncoded: true },
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
