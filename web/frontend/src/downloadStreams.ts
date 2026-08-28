export interface DownloadableStream {
  label: string;
  filename: string;
  protocol?: string | null;
  endpoint?: string | null;
  paint?: number;
}

function normalizeDownloadEndpoint(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * One series per job file / publish URL. A 4-destination run must not export
 * six streams because the same WHIP or RTMP path was written twice.
 */
export function uniqueDownloadStreams(streams: DownloadableStream[]): DownloadableStream[] {
  const kept: DownloadableStream[] = [];
  const paintOf = (stream: DownloadableStream) => stream.paint ?? 0;
  const urlIdOf = (stream: DownloadableStream): string | null => {
    const protocol = (stream.protocol || "").trim().toLowerCase();
    const endpoint = normalizeDownloadEndpoint(stream.endpoint || "");
    if (!protocol || !endpoint || protocol === "moq") {
      return null;
    }
    return `${protocol}:${endpoint}`;
  };

  for (const stream of streams) {
    const filename = (stream.filename || "").trim();
    if (!filename) {
      continue;
    }
    const urlId = urlIdOf(stream);
    const existingIdx = kept.findIndex(
      (item) => item.filename === filename || (urlId != null && urlIdOf(item) === urlId),
    );
    if (existingIdx >= 0) {
      if (paintOf(stream) > paintOf(kept[existingIdx])) {
        kept[existingIdx] = { ...stream, filename };
      }
      continue;
    }
    kept.push({ ...stream, filename });
  }
  return kept.map((stream) => ({ label: stream.label, filename: stream.filename }));
}
