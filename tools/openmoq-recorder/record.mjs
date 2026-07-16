#!/usr/bin/env node
/**
 * openmoq-fmp4-record — subscribe to an OpenMOQ/moqx relay (draft 16) and write
 * post-relay CMAF fMP4 to a file for ingest VMAF scoring.
 *
 * Usage:
 *   node record.mjs <relay-url> <namespace> <output.mp4>
 *       [--insecure-skip-verify] [--duration SEC]
 *
 * Media path matches the benchmark MoQ player: subscribe vide_1 directly with a
 * known init segment. Live catalog object delivery on moqx has been flaky
 * (SUBSCRIBE_OK without a delivered catalog object), which left recordings empty.
 */

import { createWriteStream } from 'node:fs';
import { URL } from 'node:url';
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { MoqtConnection } from '@moqt/webtransport';
import { resolveCertSha256 } from './cert.mjs';
import { nodeSessionToWebTransportLike } from './wt-adapter.mjs';
import { OPENMOQ_VIDEO_INIT_B64, OPENMOQ_VIDEO_TRACK } from './openmoq-init.mjs';

const te = new TextEncoder();
const log = (...args) => console.error('[openmoq-record]', ...args);

function usage() {
  console.error(
    'usage: openmoq-fmp4-record <relay-url> <namespace> <output.mp4> '
    + '[--insecure-skip-verify] [--duration SEC]',
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
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--insecure-skip-verify') {
      insecure = true;
    } else if (argv[i] === '--duration' && i + 1 < argv.length) {
      durationSec = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(durationSec) || durationSec < 0) usage();
    } else {
      usage();
    }
  }
  return { probe: false, relayUrl, namespace, outputPath, insecure, durationSec };
}

function namespaceParts(namespace) {
  return namespace.split('/').filter((part) => part.length > 0);
}

function isNamespaceNotReadyError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes('no such namespace') || msg.includes('no such track');
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
    protocols: ['moqt-16', 'moqt-18'],
  };

  if (!insecure) {
    wtOptions.serverCertificateHashes = [{
      algorithm: 'sha-256',
      value: resolveCertSha256(parsed.hostname, port),
    }];
  }

  const transport = new WebTransport(wtUrl, wtOptions);
  await transport.ready;

  const conn = new MoqtConnection(16);
  let closing = false;
  conn.onError = (err) => {
    if (!closing) log('connection error:', err.message);
  };
  conn.onClose = (code, reason) => {
    if (!closing) log(`connection closed code=${code} reason=${reason ?? ''}`);
  };

  await conn.connect(nodeSessionToWebTransportLike(transport));
  log(`SETUP complete (draft 16) url=${wtUrl}`);

  return {
    conn,
    close: async () => {
      closing = true;
      try { await conn.close(); } catch { /* ignore */ }
      try { transport.close(); } catch { /* ignore */ }
      try { await transport.closed; } catch { /* ignore */ }
    },
  };
}

async function subscribeVideoWhenReady(conn, nsParts, trackName, deadlineMs, onObject) {
  let lastError;
  while (Date.now() < deadlineMs) {
    try {
      const sub = await conn.subscribeTrack(
        nsParts.map((part) => te.encode(part)),
        te.encode(trackName),
        { onObject },
      );
      log(`subscribed track=${trackName}`);
      return sub;
    } catch (err) {
      lastError = err;
      if (!isNamespaceNotReadyError(err)) {
        throw err;
      }
      log(`publisher not ready yet (${err.message}); retrying...`);
      await sleep(500);
    }
  }
  throw lastError ?? new Error(`timeout waiting for track ${trackName}`);
}

async function recordVideoTrack(conn, nsParts, trackName, out, deadlineMs) {
  let fragments = 0;
  let bytesWritten = 0;

  const sub = await subscribeVideoWhenReady(
    conn,
    nsParts,
    trackName,
    deadlineMs,
    (obj) => {
      if (obj.kind !== 'data' || obj.payload.length === 0) return;
      out.write(Buffer.from(obj.payload));
      fragments += 1;
      bytesWritten += obj.payload.length;
    },
  );

  try {
    while (Date.now() < deadlineMs) {
      await sleep(250);
    }
  } finally {
    await sub.unsubscribe().catch(() => { /* best effort */ });
  }

  log(`recorded ${fragments} fragments (${bytesWritten} bytes) track=${trackName}`);
  return { fragments, bytesWritten };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.probe) {
    return probeRuntime();
  }

  const { relayUrl, namespace, outputPath, insecure, durationSec } = args;
  const nsParts = namespaceParts(namespace);
  if (nsParts.length === 0) {
    throw new Error('namespace is required');
  }

  const totalSec = durationSec > 0 ? durationSec : 90;
  const deadlineMs = Date.now() + totalSec * 1000;

  const client = await connectRelay(relayUrl, { insecure });
  const out = createWriteStream(outputPath, { flags: 'w' });
  try {
    const initBytes = decodeInitData(OPENMOQ_VIDEO_INIT_B64);
    if (!initBytes.length) {
      throw new Error('missing openmoq video init segment');
    }
    await new Promise((resolve, reject) => {
      out.write(Buffer.from(initBytes), (err) => (err ? reject(err) : resolve()));
    });
    log(`wrote init segment (${initBytes.length} bytes) track=${OPENMOQ_VIDEO_TRACK}`);

    const result = await recordVideoTrack(
      client.conn,
      nsParts,
      OPENMOQ_VIDEO_TRACK,
      out,
      deadlineMs,
    );

    if (result.fragments === 0 || result.bytesWritten === 0) {
      throw new Error('no media fragments received from relay');
    }

    log(`output ready: ${outputPath}`);
    return 0;
  } finally {
    await new Promise((resolve) => out.end(resolve));
    await client.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[openmoq-record] failed:', err.message || err);
    process.exit(1);
  });
