/**
 * HTTPS pages cannot POST SDP to http://host:8889 (mixed content).
 * This API route forwards WHIP/WHEP signaling and rewrites Location.
 */
export function proxiedWebrtcSignalingUrl(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed, window.location.href);
    if (parsed.protocol === "http:" && window.isSecureContext) {
      return `/api/webrtc/sdp?url=${encodeURIComponent(parsed.href)}`;
    }
    return parsed.href;
  } catch {
    return trimmed;
  }
}
