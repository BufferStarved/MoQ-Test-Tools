import type { PlaybackEngine, PlaybackMode, PlaybackTarget } from "./playbackTypes";

const ZIXI_HTTP_PORT = 7777;
const ZIXI_UI_PORT = 4444;
const DEFAULT_STREAM_ID = "benchmark";
const DEFAULT_MOQ_NAMESPACE = "benchmark";
/** GCP Zixi SRT push input stream ID (see infra/zixi/GCP-ZIXI-RUNBOOK.md). */
const GCP_ZIXI_SRT_STREAM_ID = "SRT Test";

export const PLAYBACK_MODE_OPTIONS: { id: PlaybackMode; label: string; hint: string }[] = [
  {
    id: "auto",
    label: "Auto (recommended)",
    hint: "SRT→Zixi HLS (or WHEP / WebRTC if configured); MOQ→Chrome + WebTransport.",
  },
  {
    id: "hls",
    label: "HLS",
    hint: "HTTP Live Streaming via hls.js (live + DVR when available).",
  },
  {
    id: "dash",
    label: "DASH",
    hint: "MPEG-DASH via dash.js.",
  },
  {
    id: "whep",
    label: "WHEP (WebRTC)",
    hint: "Low-latency WebRTC preview via WHEP gateway (e.g. srt-whep).",
  },
  {
    id: "moq",
    label: "MoQ (WebTransport)",
    hint: "Media over QUIC via @playa/player (Chrome/Edge + MoQ relay).",
  },
  {
    id: "webrtc",
    label: "WebRTC (Zixi)",
    hint: "Zixi built-in WebRTC monitor player (iframe).",
  },
  {
    id: "mpegts",
    label: "MPEG-TS over HTTP",
    hint: "Low-latency TS preview from Zixi HTTP origin.",
  },
  {
    id: "zixi-embed",
    label: "Zixi player page",
    hint: "Full Zixi WebRTC player UI in an iframe.",
  },
];

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
): string {
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
          return decodeURIComponent(match[1].split("/").pop() || DEFAULT_STREAM_ID);
        } catch {
          return match[1].split("/").pop() || DEFAULT_STREAM_ID;
        }
      }
      if (ingestEndpointId?.startsWith("gcp_zixi")) {
        return GCP_ZIXI_SRT_STREAM_ID;
      }
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

export function defaultWhepPlaybackUrl(host: string, streamId: string): string {
  return `http://${host}:8080/whep/${encodeURIComponent(streamId)}`;
}

function engineForMode(
  mode: PlaybackMode,
  protocol: string,
  hasWhepUrl: boolean,
  hasMoqRelay: boolean,
): PlaybackEngine {
  if (mode === "hls") return "hls";
  if (mode === "dash") return "dash";
  if (mode === "whep") return hasWhepUrl ? "whep" : "unsupported";
  if (mode === "moq") return hasMoqRelay ? "moq" : "unsupported";
  if (mode === "webrtc" || mode === "zixi-embed") return "webrtc-embed";
  if (mode === "mpegts") return "mpegts";
  if (protocol === "moq") return hasMoqRelay ? "moq" : "unsupported";
  if (protocol === "srt" && hasWhepUrl) return "whep";
  if (protocol === "srt") return "hls";
  if (protocol === "hls") return "hls";
  if (protocol === "dash") return "dash";
  if (protocol === "webrtc") return "webrtc-embed";
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
}): PlaybackTarget {
  const mode = options.playbackMode ?? "auto";
  const dvr = options.playbackDvr ?? false;
  const host = parseHost(options.endpointUrl);
  const streamId = parseStreamId(
    options.endpointUrl,
    options.protocol,
    options.ingestEndpointId,
  );
  const zixiManaged = isZixiManagedHost(host, options.ingestEndpointId);
  const resolvedHost = host ?? "35.222.33.58";
  const moqNamespace = options.moqNamespace?.trim() || streamId || DEFAULT_MOQ_NAMESPACE;

  const whepUrl = options.whepPlaybackUrl?.trim() || "";
  const moqRelayFromField = options.moqRelayUrl?.trim() || "";
  const moqRelayFromEndpoint =
    options.protocol === "moq" && options.endpointUrl.trim()
      ? relayBaseUrl(options.endpointUrl.trim())
      : "";
  const moqRelayUrl = moqRelayFromField || moqRelayFromEndpoint;
  const hasWhepUrl = Boolean(whepUrl);
  const hasMoqRelay = Boolean(moqRelayUrl && (options.protocol === "moq" || mode === "moq"));

  const engine = engineForMode(mode, options.protocol, hasWhepUrl, hasMoqRelay);

  if (engine === "whep") {
    return {
      engine: "whep",
      url: whepUrl,
      label: "WHEP (WebRTC)",
      streamId,
      host: resolvedHost,
      note: "Requires a WHEP gateway (e.g. Eyevinn srt-whep) in front of the SRT ingest stream.",
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
      label: "MoQ (WebTransport)",
      moqNamespace,
      moqFingerprintUrl: fingerprint || proxiedMoqFingerprintUrl(webTransportUrl),
      streamId: moqNamespace,
      note: "Requires a MoQ relay with WebTransport (draft 16). Stream must be live on the relay namespace.",
    };
  }

  if (mode === "whep" && !hasWhepUrl) {
    return {
      engine: "unsupported",
      url: "",
      label: "WHEP",
      note: "Set a WHEP channel URL (e.g. http://host:8080/whep/benchmark) in playback settings.",
    };
  }

  if ((mode === "moq" || options.protocol === "moq") && !hasMoqRelay) {
    return {
      engine: "unsupported",
      url: "",
      label: "MoQ",
      note: "Set a MoQ relay URL (e.g. https://relay:4443) in playback settings.",
    };
  }

  if (!host && !zixiManaged && engine !== "unsupported") {
    return {
      engine: "unsupported",
      url: "",
      label: options.protocol.toUpperCase(),
      note: "Enter an endpoint URL to resolve a playback manifest.",
    };
  }

  if (engine === "webrtc-embed") {
    const embedUrl = zixiWebRtcEmbedUrl(resolvedHost, streamId);
    return {
      engine: "webrtc-embed",
      url: embedUrl,
      embedUrl,
      label: "Zixi WebRTC",
      streamId,
      host: resolvedHost,
      note: "Uses Zixi's built-in WebRTC monitor. Stream must be live and WebRTC-compliant (H.264 + Opus).",
    };
  }

  if (engine === "mpegts") {
    return {
      engine: "mpegts",
      url: zixiMpegTsUrl(resolvedHost, streamId),
      label: "MPEG-TS",
      streamId,
      host: resolvedHost,
      note: "Raw transport-stream preview from Zixi HTTP origin. Live only.",
    };
  }

  if (engine === "dash") {
    return {
      engine: "dash",
      url: zixiDashUrl(resolvedHost, streamId, dvr),
      label: dvr ? "DASH (DVR)" : "DASH (live)",
      streamId,
      host: resolvedHost,
      note:
        options.protocol === "dash"
          ? "Plays Zixi DASH output for this ingest stream."
          : "Plays Zixi DASH origin output while the ingest stream is active.",
    };
  }

  if (engine === "hls") {
    return {
      engine: "hls",
      url: zixiHlsUrl(resolvedHost, streamId, dvr),
      label: dvr ? "HLS (DVR)" : "HLS (live)",
      streamId,
      host: resolvedHost,
      note:
        options.protocol === "srt" && !hasWhepUrl
          ? "SRT preview uses Zixi HLS. If verify-zixi-srt-ingest.sh fails, no browser player will work until Zixi HTTP:7777 HLS output is fixed."
          : options.protocol === "rtmp"
            ? "Browsers cannot play RTMP directly. Preview uses Zixi HLS origin output."
            : "Plays Zixi HLS origin output for this stream.",
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

export function showWhepUrlField(mode: PlaybackMode | undefined, protocol: string): boolean {
  const resolved = mode ?? "auto";
  return resolved === "whep" || (resolved === "auto" && protocol === "srt");
}

export function showMoqUrlFields(
  mode: PlaybackMode | undefined,
  protocol: string,
  ingestEndpointId?: string,
): boolean {
  if (ingestEndpointId && isManagedMoqRelay(ingestEndpointId)) {
    return false;
  }
  const resolved = mode ?? "auto";
  return resolved === "moq" || protocol === "moq";
}
