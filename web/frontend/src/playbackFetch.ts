import { proxiedPlaybackUrl } from "./playbackUrls";

/** True when the URL already targets our playback proxy (relative or absolute). */
export function isProxiedPlaybackUrl(requestUrl: string): boolean {
  return requestUrl.includes("/api/playback/fetch");
}

/**
 * Resolve any hls.js / fetch request URL to a single-hop proxied URL.
 * hls.js often passes absolute URLs (http://127.0.0.1:5173/api/...) — do not re-wrap those.
 */
export function resolvePlaybackXhrUrl(requestUrl: string): string {
  if (isProxiedPlaybackUrl(requestUrl)) {
    return requestUrl;
  }
  try {
    const absolute = requestUrl.startsWith("http")
      ? requestUrl
      : new URL(requestUrl, window.location.origin).href;
    return proxiedPlaybackUrl(absolute);
  } catch {
    return proxiedPlaybackUrl(requestUrl);
  }
}
