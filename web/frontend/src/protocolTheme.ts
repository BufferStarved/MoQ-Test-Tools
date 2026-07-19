/**
 * Stable per-protocol color identity, used consistently across the top
 * summary strip, stream column accents, badges, and comparison charts — so
 * a given protocol reads the same regardless of which comparison column or
 * chart legend position it lands in on a given run.
 */
export const PROTOCOL_COLORS: Record<string, string> = {
  srt: "#22d3ee", // cyan
  rtmp: "#fb923c", // amber/orange
  moq: "#a78bfa", // violet
  webrtc: "#4ade80", // green
  dash: "#f472b6", // pink
  hls: "#facc15", // yellow
  http: "#60a5fa", // blue
};

const FALLBACK_COLORS = ["#22d3ee", "#fb923c", "#a78bfa", "#4ade80", "#f472b6", "#facc15"];

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
