import { encodeProfileSummary, type EncodeProfileSummary } from "./encodeProfiles";
import { ingestEndpointLabel } from "./ingestEndpoints";
import type { PlaybackMode } from "./playbackTypes";
import type { EndpointConfig } from "./types";

export interface ConfigDetailRow {
  label: string;
  value: string;
  note?: string;
}

export interface ConfigDetailSection {
  id: string;
  title: string;
  subtitle?: string;
  rows: ConfigDetailRow[];
}

export interface StreamConfigInput {
  label: string;
  protocol: string;
  ingestEndpointId: string;
  endpointUrl?: string;
  playbackMode?: PlaybackMode | string;
  moqNamespace?: string | null;
  zixiStreamId?: string | null;
}

function playbackLabel(mode?: string | null): string {
  switch (mode) {
    case "hls":
      return "HLS (hls.js)";
    case "ll-hls":
      return "LL-HLS (hls.js)";
    case "ll-dash":
      return "LL-DASH (dash.js)";
    case "dash":
      return "DASH (dash.js)";
    case "whep":
      return "WHEP (WebRTC)";
    case "mpegts":
      return "MPEG-TS (mpegts.js)";
    case "moq":
    case "playa":
      return "MoQ / Playa";
    case "auto":
    case undefined:
    case null:
    case "":
      return "Host default player";
    default:
      return mode;
  }
}

function encoderSection(summary: EncodeProfileSummary): ConfigDetailSection {
  return {
    id: "encoder",
    title: "Encoder",
    subtitle: "Shared ffmpeg / libx264 settings for every stream in the recipe",
    rows: [
      { label: "Ladder", value: summary.encode_ladder_label },
      { label: "Target latency", value: `${summary.target_latency_ms} ms` },
      {
        label: "GOP / keyint",
        value: `${summary.gop_frames} frames (~${summary.keyframe_interval_sec}s @ 30 fps)`,
        note: "Floored at 2s so HLS segments land on IDR boundaries",
      },
      {
        label: "VBV bufsize",
        value: `${summary.vbv_bufsize_kb} kb`,
        note: "≈ 2× maxrate over the latency window (smaller = snappier, less stable)",
      },
      {
        label: "x264 tune",
        value: summary.x264_tune ?? "default (no -tune)",
        note: summary.x264_tune
          ? "Applied when target latency ≤ 500 ms"
          : "Enabled automatically at ≤ 500 ms",
      },
      {
        label: "Bitrate",
        value: `${summary.bitrate_kbps} kbps (min ${summary.minrate_kbps} · max ${summary.maxrate_kbps})`,
      },
      { label: "Preset / profile", value: "veryfast · main · level 4.0 · no B-frames" },
    ],
  };
}

function publisherRows(
  stream: StreamConfigInput,
  summary: EncodeProfileSummary,
): ConfigDetailRow[] {
  const protocol = stream.protocol.toLowerCase();
  const rows: ConfigDetailRow[] = [
    { label: "Publish protocol", value: protocol.toUpperCase() },
  ];
  if (protocol === "srt") {
    rows.push({
      label: "SRT latency",
      value: `${summary.srt_latency_us} µs (${summary.target_latency_ms} ms)`,
      note: "Injected as the SRT latency= query param on the publish URL",
    });
  } else if (protocol === "rtmp" || protocol === "hls" || protocol === "dash") {
    rows.push({
      label: "Publish pacing",
      value: "ffmpeg -re (realtime)",
      note: "RTMP / TS-over-HTTP push; no SRT latency knob",
    });
  } else if (protocol === "moq") {
    rows.push({
      label: "MoQ publish",
      value: stream.moqNamespace ? `namespace ${stream.moqNamespace}` : "relay namespace from recipe",
      note: "openmoq CMAF publish; paced to wall clock",
    });
  } else if (protocol === "webrtc") {
    rows.push({
      label: "WHIP publish",
      value: "WebRTC ingest (WHIP)",
    });
  }
  if (stream.endpointUrl?.trim()) {
    rows.push({ label: "Publish URL", value: stream.endpointUrl.trim() });
  }
  return rows;
}

function ingestRows(stream: StreamConfigInput): ConfigDetailRow[] {
  const host = ingestEndpointLabel(stream.ingestEndpointId);
  const rows: ConfigDetailRow[] = [
    { label: "Host / ingest", value: host },
  ];
  const ingest = stream.ingestEndpointId;
  if (ingest === "gcp_zixi" || ingest.endsWith("_zixi")) {
    rows.push({
      label: "Ingest role",
      value: "Zixi Broadcaster",
      note: stream.zixiStreamId
        ? `Stream id: ${stream.zixiStreamId}`
        : "SRT/RTMP input → Fast HLS / MPEG-TS origin",
    });
  } else if (ingest === "gcp_mediamtx") {
    rows.push({
      label: "Ingest role",
      value: "MediaMTX",
      note: "SRT/RTMP/WHIP → LL-HLS / LL-DASH / WHEP",
    });
  } else if (ingest === "gcp_moq_relay") {
    rows.push({
      label: "Ingest role",
      value: "OpenMOQ relay",
      note: "WebTransport publish / subscribe",
    });
  } else if (ingest === "custom") {
    rows.push({
      label: "Ingest role",
      value: "Custom origin",
      note: "You own packaging and playback URLs",
    });
  }
  return rows;
}

function packagerRows(
  stream: StreamConfigInput,
  summary: EncodeProfileSummary,
): ConfigDetailRow[] {
  const ingest = stream.ingestEndpointId;
  const mode = (stream.playbackMode || "auto").toLowerCase();
  const rows: ConfigDetailRow[] = [];

  if (ingest === "gcp_zixi" || ingest.endsWith("_zixi")) {
    if (mode === "mpegts") {
      rows.push({
        label: "Packager",
        value: "Bypassed (MPEG-TS over HTTP)",
        note: "Direct TS origin — no HLS chunker / media_sequence",
      });
    } else {
      rows.push({
        label: "Packager",
        value: "Zixi Fast HLS",
        note: `hls_chunk_time ≈ ${summary.hls_segment_sec}s (min 2s)`,
      });
      rows.push({
        label: "Segment duration",
        value: `${summary.hls_segment_sec} s`,
        note: "Grows with latency budget up to 6s",
      });
    }
  } else if (ingest === "gcp_mediamtx") {
    if (mode === "ll-dash" || mode === "dash") {
      rows.push({
        label: "Packager",
        value: "MediaMTX + CMAF / LL-DASH sidecar",
        note: "Low-latency DASH via ffmpeg CMAF → nginx",
      });
    } else if (mode === "whep") {
      rows.push({
        label: "Packager",
        value: "None (WebRTC)",
        note: "WHEP pulls the live WebRTC session directly",
      });
    } else {
      rows.push({
        label: "Packager",
        value: "MediaMTX native HLS / LL-HLS",
        note: "Part duration follows MediaMTX low-latency HLS settings",
      });
    }
  } else if (ingest === "gcp_moq_relay") {
    rows.push({
      label: "Packager",
      value: "MoQ / CMAF objects",
      note: "No classic HLS segments — objects on the relay",
    });
  } else {
    rows.push({
      label: "Packager",
      value: "Depends on custom origin",
      note: "Segment / LL settings are owned by your packager",
    });
  }
  return rows;
}

function playerRows(
  stream: StreamConfigInput,
  summary: EncodeProfileSummary,
): ConfigDetailRow[] {
  const mode = (stream.playbackMode || "auto").toLowerCase();
  const rows: ConfigDetailRow[] = [
    { label: "Playback mode", value: playbackLabel(stream.playbackMode) },
  ];

  if (mode === "moq" || mode === "playa" || stream.protocol.toLowerCase() === "moq") {
    const catchUp = summary.moq_catch_up;
    rows.push({
      label: "MoQ target latency",
      value: `${summary.moq_target_latency_ms} ms`,
    });
    rows.push({
      label: "Catch-up",
      value: `maxRate ${catchUp.maxCatchUpRate} · threshold ${catchUp.catchUpThresholdMs} ms · recovery ${catchUp.catchUpRecoveryMs} ms`,
      note: "Rate stays at 1.0 — live-edge uses buffer seek (avoids A/V warp)",
    });
  } else if (mode === "whep") {
    rows.push({
      label: "Player buffer",
      value: "WebRTC jitter buffer (browser-managed)",
      note: "No HLS liveSync knob",
    });
  } else if (mode === "mpegts") {
    rows.push({
      label: "Player buffer",
      value: "Native / MSE progressive",
      note: "No playlist liveSync — latency ≈ network + decode",
    });
  } else {
    rows.push({
      label: "hls.js liveSyncDuration",
      value: `${summary.hls_live_sync_duration_sec.toFixed(1)} s`,
      note: "Intentional live buffer; never below one segment",
    });
    rows.push({
      label: "hls.js liveSyncDurationCount",
      value: String(summary.hls_live_sync_count),
      note: `≈ ${summary.hls_live_sync_count} × ${summary.hls_segment_sec}s segment`,
    });
  }
  return rows;
}

export function buildSharedPipelineSections(
  ladderId: string | null | undefined,
  targetLatencyMs: number | null | undefined,
): ConfigDetailSection[] {
  return [encoderSection(encodeProfileSummary(ladderId, targetLatencyMs))];
}

export function buildStreamPipelineSections(
  stream: StreamConfigInput,
  ladderId: string | null | undefined,
  targetLatencyMs: number | null | undefined,
): ConfigDetailSection[] {
  const summary = encodeProfileSummary(ladderId, targetLatencyMs);
  const prefix = stream.label;
  return [
    {
      id: `${prefix}-publisher`,
      title: "Publisher",
      subtitle: prefix,
      rows: publisherRows(stream, summary),
    },
    {
      id: `${prefix}-ingest`,
      title: "Ingest",
      subtitle: prefix,
      rows: ingestRows(stream),
    },
    {
      id: `${prefix}-packager`,
      title: "Packager",
      subtitle: prefix,
      rows: packagerRows(stream, summary),
    },
    {
      id: `${prefix}-player`,
      title: "Player",
      subtitle: prefix,
      rows: playerRows(stream, summary),
    },
  ];
}

export function buildRecipePipelineSections(
  ladderId: string | null | undefined,
  targetLatencyMs: number | null | undefined,
  endpoints: EndpointConfig[],
): ConfigDetailSection[] {
  const shared = buildSharedPipelineSections(ladderId, targetLatencyMs);
  const perStream = endpoints.flatMap((endpoint, index) =>
    buildStreamPipelineSections(
      {
        label: `Stream ${index + 1}`,
        protocol: endpoint.protocol,
        ingestEndpointId: endpoint.ingestEndpointId,
        endpointUrl: endpoint.endpointUrl,
        playbackMode: endpoint.playbackMode,
        moqNamespace: endpoint.moqNamespace,
      },
      ladderId,
      targetLatencyMs,
    ),
  );
  return [...shared, ...perStream];
}

export function buildSessionPipelineSections(streams: Array<{
  protocol: string;
  endpoint?: string;
  summary_extra?: {
    encode_ladder?: string | null;
    encode_ladder_label?: string | null;
    target_latency_ms?: number | null;
    gop_frames?: number | null;
    hls_segment_sec?: number | null;
    hls_live_sync_duration_sec?: number | null;
    hls_live_sync_count?: number | null;
    moq_target_latency_ms?: number | null;
    srt_latency_us?: number | null;
    stream_label?: string | null;
  } | null;
}>): ConfigDetailSection[] {
  if (streams.length === 0) {
    return [];
  }
  const first = streams[0].summary_extra;
  const ladder = first?.encode_ladder ?? null;
  const latency = first?.target_latency_ms ?? null;
  if (ladder == null && latency == null) {
    return [];
  }
  const shared = buildSharedPipelineSections(ladder, latency).map((section) => {
    if (section.id !== "encoder" || first?.gop_frames == null) {
      return section;
    }
    return {
      ...section,
      rows: section.rows.map((row) =>
        row.label === "GOP / keyint"
          ? { ...row, value: `${first.gop_frames} frames (from session)` }
          : row,
      ),
    };
  });
  const perStream = streams.flatMap((stream, index) =>
    buildStreamPipelineSections(
      {
        label: stream.summary_extra?.stream_label || `Stream ${index + 1}`,
        protocol: stream.protocol,
        ingestEndpointId: guessIngestFromEndpoint(stream.endpoint || ""),
        endpointUrl: stream.endpoint,
        playbackMode: "auto",
      },
      ladder,
      latency,
    ),
  );
  return [...shared, ...perStream];
}

function guessIngestFromEndpoint(endpoint: string): string {
  const url = endpoint.toLowerCase();
  if (
    url.includes("34.28.164.90") ||
    (url.startsWith("https://") && url.includes(":4443")) ||
    url.includes("/anon/")
  ) {
    return "gcp_moq_relay";
  }
  if (url.includes("mediamtx") || url.includes(":8890") || url.includes(":8889")) {
    return "gcp_mediamtx";
  }
  if (url.includes("35.222.33.58") || url.includes(":10080") || url.includes(":1935")) {
    return "gcp_zixi";
  }
  return "custom";
}
