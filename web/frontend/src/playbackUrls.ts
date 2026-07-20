import type { PlaybackEngine, PlaybackMode, PlaybackTarget } from "./playbackTypes";

const ZIXI_HTTP_PORT = 7777;
const ZIXI_UI_PORT = 4444;
const MEDIAMTX_HLS_PORT = 8888;
const MEDIAMTX_WEBRTC_PORT = 8889;
/** ffmpeg CMAF LL-DASH sidecar (nginx) beside MediaMTX. */
const MEDIAMTX_LLDASH_PORT = 8891;
const DEFAULT_STREAM_ID = "benchmark";
const DEFAULT_MOQ_NAMESPACE = "benchmark";
/** GCP Zixi SRT push input stream ID (see infra/zixi/GCP-ZIXI-RUNBOOK.md). */
const GCP_ZIXI_SRT_STREAM_ID = "SRT Test";
/** Default MediaMTX path name for publish/play. */
const MEDIAMTX_PATH = "benchmark";

export const PLAYBACK_MODE_OPTIONS: { id: PlaybackMode; label: string; hint: string }[] = [
  {
    id: "hls",
    label: "HLS Playback (Live)",
    hint: "HTTP Live Streaming via hls.js (Zixi Fast HLS or classic).",
  },
  {
    id: "ll-hls",
    label: "LL-HLS (MediaMTX)",
    hint: "Apple-style Low-Latency HLS via MediaMTX (hls.js lowLatencyMode).",
  },
  {
    id: "dash",
    label: "DASH",
    hint: "MPEG-DASH via dash.js (Zixi CMAF when available).",
  },
  {
    id: "ll-dash",
    label: "LL-DASH (MediaMTX)",
    hint: "CMAF low-latency DASH packaged beside MediaMTX (dash.js lowLatencyEnabled).",
  },
  {
    id: "whep",
    label: "WHEP (WebRTC)",
    hint: "WebRTC via MediaMTX WHEP (or another WHEP gateway).",
  },
  {
    id: "moq",
    label: "MoQ Playback (Playa)",
    hint: "Media over QUIC via Playa (Chrome/Edge + MoQ relay).",
  },
  {
    id: "mpegts",
    label: "MPEG-TS over HTTP",
    hint: "Raw Zixi HTTP-TS (http_ts_auto_out) via mpegts.js — bypasses Fast HLS packager; auto-reconnects on republish.",
  },
];

function isZixiManagedIngest(ingestEndpointId: string): boolean {
  return (
    ingestEndpointId === "gcp_zixi" ||
    ingestEndpointId.startsWith("gcp_zixi") ||
    ingestEndpointId.startsWith("aws_zixi") ||
    ingestEndpointId.startsWith("linode_zixi")
  );
}

/** Playback modes that can work for a given ingest protocol + host/packager. */
export function isPlaybackModeCompatible(
  mode: PlaybackMode,
  protocol: string,
  ingestEndpointId?: string,
): boolean {
  // Legacy "auto" is no longer selectable — coerce via defaultPlaybackModeForProtocol.
  if (mode === "auto") {
    return false;
  }
  // MoQ ingest only plays through Playa — no HLS / WHEP fallbacks.
  if (protocol === "moq") {
    return mode === "moq";
  }
  if (mode === "moq") {
    return false;
  }

  const ingest = ingestEndpointId ?? "";
  const mediamtx = isMediaMtxManaged(ingest);
  const zixi = isZixiManagedIngest(ingest);

  // MediaMTX origin: native LL-HLS, LL-DASH sidecar, HLS, and WHEP.
  if (mediamtx) {
    return mode === "ll-hls" || mode === "ll-dash" || mode === "hls" || mode === "whep";
  }

  // Zixi Broadcaster: Fast HLS + MPEG-TS only for in-app playback.
  // - DASH per-input MPD is not served (player would silently fall back to HLS).
  // - WHEP is a MediaMTX endpoint shape, not available on Zixi :7777/:4444.
  // - Zixi WebRTC UI cannot be iframed (frame-ancestors 'self').
  if (zixi) {
    return mode === "hls" || mode === "mpegts";
  }

  // Custom / unknown host: browser-safe modes only (no packager-specific LL presets).
  // WHEP requires the user to paste a real WHEP URL.
  if (protocol === "srt" || protocol === "rtmp" || protocol === "hls" || protocol === "dash") {
    return mode === "hls" || mode === "mpegts" || mode === "whep";
  }
  if (protocol === "webrtc") {
    return mode === "whep";
  }
  return false;
}

/** Concrete default player for a protocol + ingest host (no "auto" sentinel). */
export function defaultPlaybackModeForProtocol(
  protocol: string,
  ingestEndpointId?: string,
): PlaybackMode {
  if (protocol === "moq") {
    return "moq";
  }
  if (protocol === "webrtc") {
    return "whep";
  }
  if (protocol === "hls") {
    return "mpegts";
  }
  const ingest = ingestEndpointId ?? "";
  if (isMediaMtxManaged(ingest)) {
    return "ll-hls";
  }
  if (isZixiManagedIngest(ingest)) {
    return "hls";
  }
  if (protocol === "dash") {
    return "dash";
  }
  return "hls";
}

/** Compatible player options only — keeps MoQ (and other locked paths) uncluttered. */
export function playbackModesForSelection(
  protocol: string,
  ingestEndpointId?: string,
): typeof PLAYBACK_MODE_OPTIONS {
  return PLAYBACK_MODE_OPTIONS.filter((item) =>
    isPlaybackModeCompatible(item.id, protocol, ingestEndpointId),
  );
}

/** Option / breadcrumb label; marks the host's default player as recommended. */
export function playbackModeLabelForSelection(
  mode: PlaybackMode,
  protocol: string,
  ingestEndpointId?: string,
): string {
  const base =
    PLAYBACK_MODE_OPTIONS.find((item) => item.id === mode)?.label ??
    (mode === "moq" ? "MoQ Playback (Playa)" : mode);
  if (mode === defaultPlaybackModeForProtocol(protocol, ingestEndpointId)) {
    return base.includes("(recommended)") ? base : `${base} (recommended)`;
  }
  return base;
}

/** Map a resolved playback target back to a concrete mode option (for Auto copy). */
export function resolvedPlaybackModeOption(target: {
  engine: string;
  label: string;
  note?: string;
}): (typeof PLAYBACK_MODE_OPTIONS)[number] | undefined {
  if (target.note === "lowLatencyMode" || target.label.includes("LL-HLS")) {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "ll-hls");
  }
  if (target.note === "lowLatencyDash" || target.label.includes("LL-DASH")) {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "ll-dash");
  }
  if (target.engine === "hls") {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "hls");
  }
  if (target.engine === "dash") {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "dash");
  }
  if (target.engine === "whep") {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "whep");
  }
  if (target.engine === "moq") {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "moq");
  }
  if (target.engine === "mpegts") {
    return PLAYBACK_MODE_OPTIONS.find((item) => item.id === "mpegts");
  }
  return PLAYBACK_MODE_OPTIONS.find((item) => item.label === target.label);
}

/** Label + description shown under the Video player select. */
export function playbackSelectionCopy(
  mode: PlaybackMode,
  target: { engine: string; label: string; note?: string },
  protocol: string,
  ingestEndpointId?: string,
): { label: string; description: string } {
  if (protocol === "moq" || mode === "moq") {
    return {
      label: playbackModeLabelForSelection("moq", protocol, ingestEndpointId),
      description: "MoQ ingest plays only through MoQ Playback (Playa).",
    };
  }
  const resolvedMode =
    mode === "auto" ? defaultPlaybackModeForProtocol(protocol, ingestEndpointId) : mode;
  const option = PLAYBACK_MODE_OPTIONS.find((item) => item.id === resolvedMode);
  return {
    label: playbackModeLabelForSelection(resolvedMode, protocol, ingestEndpointId),
    description: option?.hint || target.note || "",
  };
}

export function isMediaMtxManaged(ingestEndpointId: string): boolean {
  return ingestEndpointId === "gcp_mediamtx" || ingestEndpointId.startsWith("gcp_mediamtx");
}

export function managedEndpointUrlLabel(protocol: string): string {
  if (protocol === "moq") return "MoQ Publish URL";
  if (protocol === "srt") return "SRT Publish URL";
  if (protocol === "rtmp") return "RTMP Publish URL";
  if (protocol === "hls") return "HLS Publish URL";
  if (protocol === "dash") return "DASH Publish URL";
  if (protocol === "webrtc") return "WebRTC Publish URL";
  return "Publish URL";
}

function parseHost(endpointUrl: string): string | null {
  if (!endpointUrl.trim()) {
    return null;
  }
  try {
    if (endpointUrl.startsWith("srt://") || endpointUrl.startsWith("rtmp://")) {
      const withoutScheme = endpointUrl.split("://")[1] ?? "";
      const hostPart = withoutScheme.split(/[/?]/)[0] ?? "";
      return hostPart.split(":")[0] || null;
    }
    return new URL(endpointUrl).hostname || null;
  } catch {
    return null;
  }
}

function parseStreamId(
  endpointUrl: string,
  protocol: string,
  ingestEndpointId?: string,
  zixiStreamId?: string,
  zixiPlaybackStreamId?: string,
): string {
  // For playback (not diagnostics/recipe), prefer the error-concealed
  // derived stream when Zixi concealment is configured — it holds a
  // continuous timeline across SRT reconnects so Fast HLS never stalls.
  // Falls back to the raw job stream id (e.g. "SRT Test"), then the preset
  // URL's own streamid.
  if (protocol === "srt" && zixiPlaybackStreamId?.trim()) {
    return zixiPlaybackStreamId.trim();
  }
  if (protocol === "srt" && zixiStreamId?.trim()) {
    return zixiStreamId.trim();
  }
  if (!endpointUrl.trim()) {
    return DEFAULT_STREAM_ID;
  }
  try {
    if (protocol === "rtmp") {
      const parts = endpointUrl.split("/").filter(Boolean);
      return parts[parts.length - 1] || DEFAULT_STREAM_ID;
    }
    if (protocol === "hls" || protocol === "dash" || protocol === "http") {
      const url = new URL(endpointUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      const candidate = parts[0] ?? DEFAULT_STREAM_ID;
      return candidate.replace(/\.(m3u8|mpd)$/i, "") || DEFAULT_STREAM_ID;
    }
    if (protocol === "srt") {
      const match = endpointUrl.match(/streamid=([^&]+)/i);
      if (match?.[1]) {
        try {
          const decoded = decodeURIComponent(match[1]);
          if (decoded.startsWith("publish:")) {
            return decoded.slice("publish:".length) || MEDIAMTX_PATH;
          }
          return decoded.split("/").pop() || DEFAULT_STREAM_ID;
        } catch {
          return match[1].split("/").pop() || DEFAULT_STREAM_ID;
        }
      }
      if (ingestEndpointId && isMediaMtxManaged(ingestEndpointId)) {
        return MEDIAMTX_PATH;
      }
      if (ingestEndpointId?.startsWith("gcp_zixi")) {
        return GCP_ZIXI_SRT_STREAM_ID;
      }
    }
    if (protocol === "webrtc" && ingestEndpointId && isMediaMtxManaged(ingestEndpointId)) {
      return MEDIAMTX_PATH;
    }
    if (protocol === "moq") {
      try {
        const url = new URL(endpointUrl);
        return url.searchParams.get("namespace") || DEFAULT_MOQ_NAMESPACE;
      } catch {
        return DEFAULT_MOQ_NAMESPACE;
      }
    }
  } catch {
    return DEFAULT_STREAM_ID;
  }
  return DEFAULT_STREAM_ID;
}

function isZixiManagedHost(host: string | null, ingestEndpointId: string): boolean {
  if (!host) {
    return ingestEndpointId === "gcp_zixi";
  }
  return (
    ingestEndpointId.startsWith("gcp_zixi") ||
    ingestEndpointId.startsWith("aws_zixi") ||
    ingestEndpointId.startsWith("linode_zixi") ||
    host === "35.222.33.58"
  );
}

export function relayBaseUrl(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return endpointUrl.replace(/\/moq-relay\/?$/, "");
  }
}

export function relayWebTransportUrl(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl.trim());
    const path =
      url.pathname && url.pathname !== "/" ? url.pathname.replace(/\/$/, "") : "/moq-relay";
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    const trimmed = endpointUrl.trim().replace(/\/$/, "");
    return trimmed.includes("/moq-relay") ? trimmed : `${trimmed}/moq-relay`;
  }
}

export function moqDefaultsFromPublishUrl(publishUrl: string): {
  relayUrl: string;
  webTransportUrl: string;
  namespace: string;
  fingerprintUrl: string;
} {
  const relayUrl = relayBaseUrl(publishUrl);
  const webTransportUrl = relayWebTransportUrl(publishUrl);
  return {
    relayUrl,
    webTransportUrl,
    namespace: DEFAULT_MOQ_NAMESPACE,
    fingerprintUrl: proxiedMoqFingerprintUrl(webTransportUrl),
  };
}

export function proxiedMoqFingerprintUrl(relayUrl: string): string {
  return `/api/moq/fingerprint?relay=${encodeURIComponent(relayUrl)}`;
}

export function isManagedMoqRelay(ingestEndpointId: string): boolean {
  return ingestEndpointId === "gcp_moq_relay";
}

function zixiHlsUrl(host: string, streamId: string, dvr: boolean): string {
  const url = `http://${host}:${ZIXI_HTTP_PORT}/playback.m3u8?stream=${encodeURIComponent(streamId)}`;
  return dvr ? `${url}&dvr` : url;
}

function zixiDashUrl(host: string, streamId: string, dvr: boolean): string {
  const primary = `http://${host}:${ZIXI_HTTP_PORT}/playback.mpd?stream=${encodeURIComponent(streamId)}`;
  if (dvr) {
    return `${primary}&dvr`;
  }
  return primary;
}

function zixiMpegTsUrl(host: string, streamId: string): string {
  return `http://${host}:${ZIXI_HTTP_PORT}/${encodeURIComponent(streamId)}.ts`;
}

function zixiWebRtcEmbedUrl(host: string, streamId: string): string {
  return `http://${host}:${ZIXI_UI_PORT}/webrtc.html?stream=${encodeURIComponent(streamId)}`;
}

/** Browser-facing MediaMTX host — never 127.0.0.1 from co-located publish URLs. */
function mediaMtxPublicHost(host: string | null | undefined): string {
  const h = (host || "").trim();
  if (!h || h === "127.0.0.1" || h === "localhost" || h === "::1") {
    return "34.9.217.178";
  }
  return h;
}

function mediaMtxHlsUrl(host: string, path: string): string {
  const clean = (path || MEDIAMTX_PATH).replace(/^\/+|\/+$/g, "") || MEDIAMTX_PATH;
  return `http://${mediaMtxPublicHost(host)}:${MEDIAMTX_HLS_PORT}/${encodeURIComponent(clean)}/index.m3u8`;
}

function mediaMtxWhepUrl(host: string, path: string): string {
  const clean = (path || MEDIAMTX_PATH).replace(/^\/+|\/+$/g, "") || MEDIAMTX_PATH;
  return `http://${mediaMtxPublicHost(host)}:${MEDIAMTX_WEBRTC_PORT}/${encodeURIComponent(clean)}/whep`;
}

function mediaMtxLlDashUrl(host: string, path: string): string {
  const clean = (path || MEDIAMTX_PATH).replace(/^\/+|\/+$/g, "") || MEDIAMTX_PATH;
  return `http://${mediaMtxPublicHost(host)}:${MEDIAMTX_LLDASH_PORT}/${encodeURIComponent(clean)}/manifest.mpd`;
}

export function defaultWhepPlaybackUrl(host: string, streamId: string): string {
  // Prefer MediaMTX WHEP shape; custom gateways can still override in the UI.
  return mediaMtxWhepUrl(host, streamId);
}

function engineForMode(
  mode: PlaybackMode,
  protocol: string,
  hasWhepUrl: boolean,
  hasMoqRelay: boolean,
  mediamtx: boolean,
): PlaybackEngine {
  if (mode === "ll-hls" || mode === "hls") return "hls";
  if (mode === "ll-dash" || mode === "dash") return "dash";
  if (mode === "whep") return hasWhepUrl || mediamtx ? "whep" : "unsupported";
  if (mode === "moq") return hasMoqRelay ? "moq" : "unsupported";
  // Legacy Zixi iframe modes — Broadcaster sends frame-ancestors 'self', so they
  // cannot play inside this app. Prefer HLS / MPEG-TS / WHEP instead.
  if (mode === "webrtc" || mode === "zixi-embed") return "unsupported";
  if (mode === "mpegts") return "mpegts";
  if (protocol === "moq") return hasMoqRelay ? "moq" : "unsupported";
  if (mediamtx) return "hls";
  if (protocol === "srt" && hasWhepUrl) return "whep";
  if (protocol === "srt") return "hls";
  // Zixi TS-over-HTTP push has no Fast HLS/DASH manifest for this input — MPEG-TS
  // is the only playable option.
  if (protocol === "hls") return "mpegts";
  // Zixi per-input DASH MPD needs an adaptive group we don't have — route through
  // the "dash" engine so Auto gets the same Fast HLS fallback (with a clear label)
  // that explicit DASH mode uses, instead of a raw, unlabeled MPEG-TS attempt.
  if (protocol === "dash") return "dash";
  if (protocol === "webrtc") return mediamtx ? "whep" : "unsupported";
  return "hls";
}

export function resolvePlaybackTarget(options: {
  protocol: string;
  endpointUrl: string;
  ingestEndpointId: string;
  playbackMode?: PlaybackMode;
  playbackDvr?: boolean;
  whepPlaybackUrl?: string;
  moqRelayUrl?: string;
  moqFingerprintUrl?: string;
  moqNamespace?: string;
  zixiStreamId?: string;
  zixiPlaybackStreamId?: string;
}): PlaybackTarget {
  const mode =
    options.playbackMode && options.playbackMode !== "auto"
      ? options.playbackMode
      : defaultPlaybackModeForProtocol(options.protocol, options.ingestEndpointId);
  const dvr = options.playbackDvr ?? false;
  const host = parseHost(options.endpointUrl);
  const streamId = parseStreamId(
    options.endpointUrl,
    options.protocol,
    options.ingestEndpointId,
    options.zixiStreamId,
    options.zixiPlaybackStreamId,
  );
  const zixiManaged = isZixiManagedHost(host, options.ingestEndpointId);
  const mediamtx = isMediaMtxManaged(options.ingestEndpointId);
  const resolvedHost = host ?? (mediamtx ? "34.9.217.178" : "35.222.33.58");
  const moqNamespace = options.moqNamespace?.trim() || streamId || DEFAULT_MOQ_NAMESPACE;
  const pathId = streamId || MEDIAMTX_PATH;

  // Only invent a WHEP URL for MediaMTX. On Zixi/custom, require an explicit URL
  // so we never point :8889 WHEP at a Broadcaster host.
  const whepUrl =
    options.whepPlaybackUrl?.trim() ||
    (mediamtx ? mediaMtxWhepUrl(resolvedHost, pathId) : "");
  const moqRelayFromField = options.moqRelayUrl?.trim() || "";
  const moqRelayFromEndpoint =
    options.protocol === "moq" && options.endpointUrl.trim()
      ? relayBaseUrl(options.endpointUrl.trim())
      : "";
  const moqRelayUrl = moqRelayFromField || moqRelayFromEndpoint;
  const hasWhepUrl = Boolean(whepUrl);
  const hasMoqRelay = Boolean(moqRelayUrl && (options.protocol === "moq" || mode === "moq"));

  const engine = engineForMode(mode, options.protocol, hasWhepUrl, hasMoqRelay, mediamtx);

  if (engine === "whep") {
    return {
      engine: "whep",
      url: whepUrl,
      label: "WHEP (WebRTC)",
      streamId: pathId,
      host: resolvedHost,
    };
  }

  if (engine === "moq") {
    const fingerprint = options.moqFingerprintUrl?.trim();
    const webTransportUrl = moqRelayUrl.includes("/moq-relay")
      ? moqRelayUrl
      : relayWebTransportUrl(moqRelayUrl);
    return {
      engine: "moq",
      url: webTransportUrl,
      label: "MoQ Playback (Playa)",
      moqNamespace,
      moqFingerprintUrl: fingerprint || proxiedMoqFingerprintUrl(webTransportUrl),
      streamId: moqNamespace,
    };
  }

  if (mode === "whep" && !hasWhepUrl) {
    return {
      engine: "unsupported",
      url: "",
      label: "WHEP",
      note: "Set a WHEP channel URL (e.g. http://host:8889/benchmark/whep) in playback settings.",
    };
  }

  if ((mode === "moq" || options.protocol === "moq") && !hasMoqRelay) {
    return {
      engine: "unsupported",
      url: "",
      label: "MoQ Playback (Playa)",
      note: "Set a MoQ relay URL (e.g. https://relay:4443) in playback settings.",
    };
  }

  if (!host && !zixiManaged && !mediamtx && engine !== "unsupported") {
    return {
      engine: "unsupported",
      url: "",
      label: options.protocol.toUpperCase(),
      note: "Enter an endpoint URL to resolve a playback manifest.",
    };
  }

  if (mode === "webrtc" || mode === "zixi-embed") {
    return {
      engine: "unsupported",
      url: zixiWebRtcEmbedUrl(resolvedHost, streamId),
      label: "Zixi WebRTC",
      note:
        "Zixi's WebRTC player UI cannot be embedded here (X-Frame-Options / CSP frame-ancestors). "
        + "Open it from the Zixi Broadcaster UI in a new tab, or use HLS / MPEG-TS for in-app playback.",
      streamId,
      host: resolvedHost,
    };
  }

  if (engine === "mpegts") {
    return {
      engine: "mpegts",
      url: zixiMpegTsUrl(resolvedHost, streamId),
      label: "MPEG-TS",
      streamId,
      host: resolvedHost,
    };
  }

  if (engine === "dash") {
    const useLlDash = mediamtx || (mode === "ll-dash" && !zixiManaged);
    if (useLlDash) {
      return {
        engine: "dash",
        url: mediaMtxLlDashUrl(resolvedHost, pathId),
        label: "LL-DASH (MediaMTX)",
        streamId: pathId,
        host: mediaMtxPublicHost(resolvedHost),
        note: "lowLatencyDash",
      };
    }
    // Zixi per-input MPD is not served without an adaptive group. Fall back to
    // Fast HLS so "DASH Playback" still shows video instead of a silent blank player.
    return {
      engine: "hls",
      url: zixiHlsUrl(resolvedHost, streamId, dvr),
      label: dvr ? "HLS (DASH unavailable · DVR)" : "HLS (DASH MPD unavailable)",
      streamId,
      host: resolvedHost,
      note: "zixiDashFallbackHls",
    };
  }

  if (engine === "hls") {
    // Apple-style LL-HLS only from MediaMTX. Zixi Fast HLS stays on the Zixi URLs.
    const useMediaMtxHls = mediamtx || (mode === "ll-hls" && !zixiManaged);
    return {
      engine: "hls",
      url: useMediaMtxHls
        ? mediaMtxHlsUrl(resolvedHost, pathId)
        : zixiHlsUrl(resolvedHost, streamId, dvr),
      label: useMediaMtxHls
        ? "LL-HLS (MediaMTX)"
        : dvr
          ? "HLS Playback (DVR)"
          : "HLS Playback (Live)",
      streamId: useMediaMtxHls ? pathId : streamId,
      host: resolvedHost,
      note: useMediaMtxHls ? "lowLatencyMode" : undefined,
    };
  }

  return {
    engine: "unsupported",
    url: "",
    label: options.protocol.toUpperCase(),
    note: "No browser playback path is configured for this protocol.",
  };
}

export function proxiedPlaybackUrl(remoteUrl: string): string {
  return `/api/playback/fetch?url=${encodeURIComponent(remoteUrl)}`;
}

export function showWhepUrlField(mode: PlaybackMode | undefined, _protocol?: string): boolean {
  return mode === "whep";
}

export function showMoqUrlFields(
  mode: PlaybackMode | undefined,
  protocol: string,
  ingestEndpointId?: string,
): boolean {
  if (ingestEndpointId && isManagedMoqRelay(ingestEndpointId)) {
    return false;
  }
  return mode === "moq" || protocol === "moq";
}
