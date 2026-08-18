/**
 * Protocol chips (badges, verdicts) keep a stable protocol hue.
 * Comparison graph lines use streamColor / assignStreamColors so two SRT
 * (or two MoQ) outputs to different clouds are not painted the same.
 */
export const PROTOCOL_COLORS: Record<string, string> = {
  srt: "#22d3ee",
  rtmp: "#fb923c",
  moq: "#a78bfa",
  webrtc: "#4ade80",
  dash: "#f472b6",
  hls: "#facc15",
  http: "#60a5fa",
};

/** Distinct palette for comparison legs / output columns. */
export const STREAM_COLORS = [
  "#22d3ee",
  "#f472b6",
  "#a78bfa",
  "#4ade80",
  "#fb923c",
  "#facc15",
  "#60a5fa",
  "#2dd4bf",
];

const FALLBACK_COLORS = STREAM_COLORS;

export interface OutputColorConfig {
  protocol?: string | null;
  ingestEndpointId?: string | null;
  playbackMode?: string | null;
  endpoint?: string | null;
}

export function outputConfigKey(config: OutputColorConfig): string {
  const protocol = (config.protocol ?? "").trim().toLowerCase();
  const ingest = (config.ingestEndpointId ?? "").trim().toLowerCase();
  const playback = (config.playbackMode ?? "").trim().toLowerCase();
  const endpoint = (config.endpoint ?? "").trim().toLowerCase();
  if (protocol || ingest || playback) {
    return `${protocol}|${ingest}|${playback}`;
  }
  return endpoint;
}

/**
 * Assign colors so identical output configs share a hue and every distinct
 * config in the set gets a unique palette slot (protocol alone is not a key).
 */
export function assignStreamColors(configs: OutputColorConfig[]): string[] {
  const assigned = new Map<string, string>();
  let next = 0;
  return configs.map((config, index) => {
    const key = outputConfigKey(config) || `leg-${index}`;
    const existing = assigned.get(key);
    if (existing) {
      return existing;
    }
    const color = STREAM_COLORS[next % STREAM_COLORS.length];
    next += 1;
    assigned.set(key, color);
    return color;
  });
}

export function streamColor(index: number, config?: OutputColorConfig): string {
  if (config && outputConfigKey(config)) {
    return assignStreamColors([config])[0];
  }
  return STREAM_COLORS[index % STREAM_COLORS.length];
}

export function protocolColor(protocol?: string | null, fallbackIndex = 0): string {
  const key = (protocol ?? "").trim().toLowerCase();
  return PROTOCOL_COLORS[key] ?? FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
}

export function protocolLabel(protocol?: string | null): string {
  const key = (protocol ?? "").trim().toLowerCase();
  if (key === "moq") return "MoQ";
  if (key === "webrtc") return "WebRTC";
  if (!key) return "Stream";
  return key.toUpperCase();
}
