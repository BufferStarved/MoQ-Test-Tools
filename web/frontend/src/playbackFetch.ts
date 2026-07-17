import { proxiedPlaybackUrl } from "./playbackUrls";

/** True when the URL already targets our playback proxy (relative or absolute). */
export function isProxiedPlaybackUrl(requestUrl: string): boolean {
  return requestUrl.includes("/api/playback/fetch");
}

/**
 * If a URL was wrongly resolved as http://zixi-host/api/playback/fetch?url=...,
 * extract the inner remote media URL so we proxy it once from the local app.
 */
export function unwrapNestedPlaybackFetchUrl(requestUrl: string): string | null {
  try {
    const parsed = new URL(requestUrl, window.location.origin);
    if (!parsed.pathname.includes("/api/playback/fetch")) {
      return null;
    }
    const inner = parsed.searchParams.get("url");
    if (!inner) {
      return null;
    }
    // Nested: outer url points at another /api/playback/fetch on a remote host.
    if (inner.includes("/api/playback/fetch")) {
      try {
        const nested = new URL(inner);
        const deeper = nested.searchParams.get("url");
        if (deeper) {
          return deeper;
        }
      } catch {
        /* keep inner */
      }
    }
    // Wrong host: http://35.x.x.x/api/playback/fetch?url=http://35.../playback.ts
    if (parsed.origin !== window.location.origin && inner.startsWith("http")) {
      return inner;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve any hls.js / fetch request URL to a single-hop proxied URL.
 * hls.js often passes absolute URLs (http://127.0.0.1:5173/api/...) — do not re-wrap those.
 */
export function resolvePlaybackXhrUrl(requestUrl: string): string {
  const unwrapped = unwrapNestedPlaybackFetchUrl(requestUrl);
  if (unwrapped) {
    return proxiedPlaybackUrl(unwrapped);
  }
  if (isProxiedPlaybackUrl(requestUrl)) {
    // Relative /api/... must stay on the local origin.
    if (requestUrl.startsWith("/")) {
      return requestUrl;
    }
    try {
      const parsed = new URL(requestUrl, window.location.origin);
      if (parsed.origin === window.location.origin) {
        return `${parsed.pathname}${parsed.search}`;
      }
    } catch {
      return requestUrl;
    }
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
