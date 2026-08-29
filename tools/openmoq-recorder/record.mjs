#!/usr/bin/env node
/**
 * openmoq-fmp4-record — subscribe to an OpenMOQ/moqx relay (draft 18) and write
 * post-relay CMAF fMP4 to a file for ingest VMAF scoring.
 *
 * Usage:
 *   node record.mjs <relay-url> <namespace> <output.mp4>
 *       [--insecure-skip-verify] [--duration SEC]
 *
 * Media path:
 *   - Browser LOC publish advertises track `video`
 *   - Cloud openmoq-publisher advertises CMAF `vide_1`
 * One SUBSCRIBE per session. 0x10 / §11.1 alias reuse reconnects instead
 * of retrying on the same connection (Linode :14433 recorded 0 bytes).
 * CMAF uses AbsoluteStart and prefers catalog initDataList over a baked
 * init. Writing a CMAF init before knowing which track landed is what
 * made browser VMAF fail with "Unknown track: vide_1".
 */

import { createWriteStream } from 'node:fs';
import { URL } from 'node:url';
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { MoqtConnection } from '@moqt/webtransport';
import { readLengthPrefixedBytes, readVarint } from '@moqt/transport';
import { resolveCertSha256 } from './cert.mjs';
import { nodeSessionToWebTransportLike } from './wt-adapter.mjs';
import { OPENMOQ_VIDEO_INIT_B64 } from './openmoq-init.mjs';
import {
  CATALOG_TRACK,
  CMAF_VIDEO_TRACK,
  catalogInitB64,
  isAliasReuseError,
  isLocTrack,
  isRetryableSubscribeError,
  nextTrackForReconnect,
  orderedTrackNames,
  parseCatalogObject,
  reconnectBackoffMs,
  shouldResubscribeAfterSilence,
  subscribeFilterForTrack,
  wantsCatalogSubscribe,
} from './record-policy.mjs';

const VIDEO_CONFIG_ID = 0x0d;
const ANNEX_B_START = new Uint8Array([0, 0, 0, 1]);

const te = new TextEncoder();
const log = (...args) => console.error('[openmoq-record]', ...args);

function usage() {
  console.error(
    'usage: openmoq-fmp4-record <relay-url> <namespace> <output.mp4> '
    + '[--insecure-skip-verify] [--duration SEC] [--track NAME]...',
  );
  process.exit(2);
}

async function probeRuntime() {
  const { checkQuicheInit, Http3WebTransportClient } = await import(
    '@fails-components/webtransport-transport-http3-quiche'
  );
  checkQuicheInit();
  if (!Http3WebTransportClient) {
    throw new Error('Http3WebTransportClient unavailable');
  }

  await quicheLoaded;
  if (!WebTransport) {
    throw new Error('WebTransport unavailable');
  }
  log('quic runtime ok');
  return 0;
}

function parseArgs(argv) {
  if (argv.includes('--probe')) {
    return { probe: true };
  }
  if (argv.length < 3) usage();
  const relayUrl = argv[0];
  const namespace = argv[1];
  const outputPath = argv[2];
  let insecure = false;
  let durationSec = 0;
  const tracks = [];
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--insecure-skip-verify') {
      insecure = true;
    } else if (argv[i] === '--duration' && i + 1 < argv.length) {
      durationSec = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(durationSec) || durationSec < 0) usage();
    } else if (argv[i] === '--track' && i + 1 < argv.length) {
      tracks.push(argv[++i]);
    } else {
      usage();
    }
  }
  return {
    probe: false,
    relayUrl,
    namespace,
    outputPath,
    insecure,
    durationSec,
    tracks: tracks.length ? tracks : [CMAF_VIDEO_TRACK, 'video'],
  };
}

function namespaceParts(namespace) {
  return namespace.split('/').filter((part) => part.length > 0);
}


function isBenignStreamReset(err) {
  const msg = String(err?.message ?? err);
  return /resetstream/i.test(msg) || /reset.?stream/i.test(msg);
}

/** Pull SPS/PPS from an AVCDecoderConfigurationRecord (avcC). */
function avcCParameterSetsToAnnexB(avcC) {
  if (!avcC || avcC.byteLength < 7 || avcC[0] !== 1) {
    return new Uint8Array(0);
  }
  const view = new DataView(avcC.buffer, avcC.byteOffset, avcC.byteLength);
  const parts = [];
  let offset = 5;
  const numSps = avcC[offset] & 0x1f;
  offset += 1;
  for (let i = 0; i < numSps; i += 1) {
    if (offset + 2 > avcC.byteLength) break;
    const length = view.getUint16(offset);
    offset += 2;
    if (offset + length > avcC.byteLength) break;
    const nal = new Uint8Array(4 + length);
    nal.set(ANNEX_B_START, 0);
    nal.set(avcC.subarray(offset, offset + length), 4);
    parts.push(nal);
    offset += length;
  }
  if (offset >= avcC.byteLength) {
    return concatAnnexB(parts);
  }
  const numPps = avcC[offset];
  offset += 1;
  for (let i = 0; i < numPps; i += 1) {
    if (offset + 2 > avcC.byteLength) break;
    const length = view.getUint16(offset);
    offset += 2;
    if (offset + length > avcC.byteLength) break;
    const nal = new Uint8Array(4 + length);
    nal.set(ANNEX_B_START, 0);
    nal.set(avcC.subarray(offset, offset + length), 4);
    parts.push(nal);
    offset += length;
  }
  return concatAnnexB(parts);
}

function concatAnnexB(parts) {
  if (!parts.length) {
    return new Uint8Array(0);
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** LOC VIDEO_CONFIG (id 0x0d) from draft-16 delta-encoded object extensions. */
function locVideoConfig(extensions) {
  if (!extensions || extensions.byteLength === 0) {
    return null;
  }
  try {
    let pos = 0;
    let prevType = 0n;
    while (pos < extensions.length) {
      const type = readVarint(extensions, pos);
      pos += type.bytesRead;
      const absType = prevType + type.value;
      prevType = absType;
      if (absType % 2n === 0n) {
        const val = readVarint(extensions, pos);
        pos += val.bytesRead;
      } else {
        const bytes = readLengthPrefixedBytes(extensions, pos);
        pos += bytes.bytesRead;
        if (Number(absType) === VIDEO_CONFIG_ID) {
          return bytes.value;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function lengthPrefixedToAnnexB(payload) {
  if (payload.byteLength >= 4 && payload[0] === 0 && payload[1] === 0) {
    if (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1)) {
      return payload;
    }
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const start = new Uint8Array([0, 0, 0, 1]);
  const parts = [];
  let offset = 0;
  while (offset + 4 <= payload.byteLength) {
    const length = view.getUint32(offset);
    offset += 4;
    if (length <= 0 || offset + length > payload.byteLength) {
      break;
    }
    const nal = new Uint8Array(4 + length);
    nal.set(start, 0);
    nal.set(payload.subarray(offset, offset + length), 4);
    parts.push(nal);
    offset += length;
  }
  if (!parts.length) {
    return payload;
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeInitData(initDataB64) {
  const buf = Buffer.from(initDataB64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function connectRelay(relayUrl, { insecure }) {
  const parsed = new URL(relayUrl);
  if (!parsed.hostname) {
    throw new Error(`Invalid relay URL: ${relayUrl}`);
  }
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const wtUrl = relayUrl;

  await quicheLoaded;

  /** @type {Record<string, unknown>} */
  const wtOptions = {
    protocols: ['moqt-18'],
  };

  if (!insecure) {
    const hash = resolveCertSha256(parsed.hostname, port);
    if (hash) {
      wtOptions.serverCertificateHashes = [{
        algorithm: 'sha-256',
        value: hash,
      }];
      log(`wt pin sha-256 host=${parsed.hostname} port=${port}`);
    } else {
      // :14433 public LE — Node quiche CA verify is experimental. A leftover
      // :4433 hostname pin here is what produced "Opening handshake failed".
      log(`wt public-ca host=${parsed.hostname} port=${port} (no serverCertificateHashes)`);
    }
  } else {
    log(`wt insecure host=${parsed.hostname} port=${port}`);
  }

  const transport = new WebTransport(wtUrl, wtOptions);
  try {
    await transport.ready;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/opening handshake failed/i.test(msg) && !wtOptions.serverCertificateHashes) {
      throw new Error(
        `${msg} (Node WebTransport public-CA verify on ${parsed.hostname}:${port}; `
        + 'do not pin the leftover :4433 hash onto :14433)',
      );
    }
    throw err;
  }

  const conn = new MoqtConnection(18);
  let closing = false;
  conn.onError = (err) => {
    if (closing) return;
    // Relay RESET of a GOP uni-stream is expected at group boundaries /
    // extra subscribers. Treating it as fatal aborted ingest VMAF with
    // "Resetstream with code:3" while the session was still up.
    if (isBenignStreamReset(err)) {
      log('stream reset (continuing):', err.message);
      return;
    }
    log('connection error:', err.message);
  };
  conn.onClose = (code, reason) => {
    if (!closing) log(`connection closed code=${code} reason=${reason ?? ''}`);
  };

  await conn.connect(nodeSessionToWebTransportLike(transport));
  log(`SETUP complete (draft 18) url=${wtUrl}`);
  log('recorder=loc-cmaf-v2');

  return {
    conn,
    close: async () => {
      closing = true;
      // conn.close() already tears down the WT session; a second CloseSession
      // logs "WebTransportHttp3 close sent twice".
      try { await conn.close(); } catch { /* ignore */ }
      try { await transport.closed; } catch { /* ignore */ }
    },
  };
}

async function subscribeTrackOnce(conn, nsParts, trackName, onObject) {
  const sub = await conn.subscribeTrack(
    nsParts.map((part) => te.encode(part)),
    te.encode(trackName),
    {
      onObject,
      filter: subscribeFilterForTrack(trackName),
    },
  );
  log(`subscribed track=${trackName} filter=${subscribeFilterForTrack(trackName).type}`);
  return sub;
}

/**
 * One SUBSCRIBE generation per session. A 0x10 / unknown-track miss
 * must reconnect — retrying here reuses the alias (§11.1).
 */
async function subscribeVideoOnce(conn, nsParts, trackNames, onObjectForTrack) {
  let lastError;
  for (const trackName of orderedTrackNames(trackNames)) {
    try {
      const sub = await subscribeTrackOnce(
        conn,
        nsParts,
        trackName,
        onObjectForTrack(trackName),
      );
      return { sub, trackName };
    } catch (err) {
      lastError = err;
      if (!isRetryableSubscribeError(err) && !isAliasReuseError(err)) {
        throw err;
      }
      log(`track=${trackName} not ready (${err.message}); reconnect required (§11.1)`);
      throw err;
    }
  }
  throw lastError ?? new Error(`timeout waiting for tracks ${trackNames.join(',')}`);
}

async function fetchCatalogInit(conn, nsParts, trackName, deadlineMs) {
  if (Date.now() >= deadlineMs) {
    return "";
  }
  let catalog = null;
  let sub = null;
  try {
    sub = await subscribeTrackOnce(conn, nsParts, CATALOG_TRACK, (obj) => {
      if (obj.kind !== "data" || !obj.payload || obj.payload.length === 0) {
        return;
      }
      catalog = parseCatalogObject(obj.payload) || catalog;
    });
    const until = Math.min(deadlineMs, Date.now() + 4000);
    while (!catalog && Date.now() < until) {
      await sleep(100);
    }
  } catch (err) {
    if (isRetryableSubscribeError(err) || isAliasReuseError(err)) {
      log(`catalog not ready (${err.message}); reconnect required`);
      throw err;
    }
    log(`catalog subscribe skipped: ${err.message || err}`);
    return "";
  } finally {
    await sub?.unsubscribe().catch(() => { /* catalog object is retained */ });
  }
  const b64 = catalogInitB64(catalog, trackName);
  if (b64) {
    log(`catalog initDataList for ${trackName} (${b64.length} b64)`);
  }
  return b64;
}

async function recordVideoTrack(conn, nsParts, trackNames, out, deadlineMs) {
  let fragments = 0;
  let bytesWritten = 0;
  const pending = [];
  let headerReady = false;
  let loc = false;
  let wroteParameterSets = false;
  let lastObjectAt = Date.now();
  let currentSub = null;
  let currentTrack = trackNames[0] || 'video';

  function writePayload(payload) {
    if (!payload || payload.length === 0) {
      return;
    }
    out.write(Buffer.from(payload));
    fragments += 1;
    bytesWritten += payload.length;
    lastObjectAt = Date.now();
  }

  function onObjectForTrack(name) {
    return (obj) => {
      if (obj.kind !== 'data' || !obj.payload || obj.payload.length === 0) return;
      if (isLocTrack(name)) {
        const ext = obj.properties || obj.extensions;
        const avcC = locVideoConfig(ext);
        if (avcC && !wroteParameterSets) {
          const sets = avcCParameterSetsToAnnexB(avcC);
          if (sets.byteLength > 0) {
            if (headerReady) {
              writePayload(sets);
            } else {
              pending.unshift(sets);
            }
            wroteParameterSets = true;
            log(`loc wrote avcC parameter sets (${sets.byteLength} bytes)`);
          }
        }
      }
      const bytes = isLocTrack(name) ? lengthPrefixedToAnnexB(obj.payload) : obj.payload;
      if (!headerReady) {
        pending.push(bytes);
        lastObjectAt = Date.now();
        return;
      }
      writePayload(bytes);
    };
  }

  let catalogInit = "";
  if (wantsCatalogSubscribe(trackNames)) {
    catalogInit = await fetchCatalogInit(conn, nsParts, CMAF_VIDEO_TRACK, deadlineMs);
  }

  const { sub, trackName } = await subscribeVideoOnce(
    conn,
    nsParts,
    trackNames,
    onObjectForTrack,
  );
  currentSub = sub;
  currentTrack = trackName;
  loc = isLocTrack(trackName);

  if (!loc) {
    const initBytes = decodeInitData(catalogInit || OPENMOQ_VIDEO_INIT_B64);
    if (!initBytes.length) {
      throw new Error('missing openmoq video init segment');
    }
    await new Promise((resolve, reject) => {
      out.write(Buffer.from(initBytes), (err) => (err ? reject(err) : resolve()));
    });
    log(`wrote init segment (${initBytes.length} bytes) track=${currentTrack}`
      + (catalogInit ? " source=catalog" : " source=fallback"));
  } else {
    log(`loc annex-b recording track=${currentTrack}`);
  }
  headerReady = true;
  for (const bytes of pending.splice(0, pending.length)) {
    writePayload(bytes);
  }

  try {
    while (Date.now() < deadlineMs) {
      await sleep(250);
      if (shouldResubscribeAfterSilence()) {
        throw new Error('same-session resubscribe is disabled (§11.1)');
      }
    }
  } finally {
    await currentSub?.unsubscribe().catch(() => { /* best effort */ });
  }

  log(`recorded ${fragments} fragments (${bytesWritten} bytes) track=${currentTrack}`);
  return { fragments, bytesWritten, trackName: currentTrack };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.probe) {
    return probeRuntime();
  }

  const { relayUrl, namespace, outputPath, insecure, durationSec, tracks } = args;
  const nsParts = namespaceParts(namespace);
  if (nsParts.length === 0) {
    throw new Error('namespace is required');
  }

  const totalSec = durationSec > 0 ? durationSec : 90;
  const deadlineMs = Date.now() + totalSec * 1000;
  const mediaTracks = orderedTrackNames(tracks.filter((name) => name !== CATALOG_TRACK));
  log(`trying tracks=${mediaTracks.join(',')} (reconnect on 0x10 / §11.1)`);

  const out = createWriteStream(outputPath, { flags: 'w' });
  let lastError;
  let attempt = 0;
  let sessionTracks = mediaTracks.slice(0, 1);
  try {
    while (Date.now() < deadlineMs) {
      const client = await connectRelay(relayUrl, { insecure });
      try {
        const result = await recordVideoTrack(
          client.conn,
          nsParts,
          sessionTracks,
          out,
          deadlineMs,
        );
        if (result.fragments === 0 || result.bytesWritten === 0) {
          throw new Error('no media fragments received from relay');
        }
        log(`output ready: ${outputPath}`);
        return 0;
      } catch (err) {
        lastError = err;
        if (!isRetryableSubscribeError(err) && !isAliasReuseError(err)) {
          throw err;
        }
        const next = nextTrackForReconnect(mediaTracks, sessionTracks[0], err);
        sessionTracks = next ? [next] : mediaTracks.slice(0, 1);
        const waitMs = reconnectBackoffMs(attempt);
        attempt += 1;
        log(`session ${attempt} missed (${err.message}); next=${sessionTracks[0]} reconnect in ${waitMs}ms`);
        if (Date.now() + waitMs >= deadlineMs) {
          break;
        }
        await sleep(waitMs);
      } finally {
        await client.close();
      }
    }
    throw lastError ?? new Error('no media fragments received from relay');
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[openmoq-record] failed:', err.message || err);
    process.exit(1);
  });
