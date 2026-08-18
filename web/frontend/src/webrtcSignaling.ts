/**
 * HTTPS pages cannot POST SDP to http://host:8889 (mixed content).
 * This API route forwards WHIP/WHEP signaling and rewrites Location.
 */
export function proxiedWebrtcSignalingUrl(
  target: string,
  loc: { href: string; isSecureContext: boolean } = {
    href: typeof window !== "undefined" ? window.location.href : "http://localhost/",
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext : false,
  },
): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed, loc.href);
    if (parsed.protocol === "http:" && loc.isSecureContext) {
      return `/api/webrtc/sdp?url=${encodeURIComponent(parsed.href)}`;
    }
    return parsed.href;
  } catch {
    return trimmed;
  }
}
