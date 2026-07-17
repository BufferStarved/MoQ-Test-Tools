import { resultDownloadUrl } from "./api";

export interface DownloadableStream {
  label: string;
  filename: string;
}

function triggerBlobDownload(content: string, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Merge each stream's per-second CSV into a single file (one row per
 * stream/second, with a leading "stream" column) instead of making the user
 * download one CSV per leg.
 */
export async function downloadCombinedCsv(
  streams: DownloadableStream[],
  combinedFilename: string,
): Promise<void> {
  const lines: string[] = [];
  for (const stream of streams) {
    const response = await fetch(resultDownloadUrl(stream.filename, "csv"));
    if (!response.ok) {
      continue;
    }
    const rows = (await response.text()).split(/\r?\n/).filter((row) => row.length > 0);
    if (rows.length === 0) {
      continue;
    }
    const [header, ...body] = rows;
    if (lines.length === 0) {
      lines.push(`stream,${header}`);
    }
    for (const row of body) {
      lines.push(`${csvEscape(stream.label)},${row}`);
    }
  }
  if (lines.length === 0) {
    return;
  }
  triggerBlobDownload(lines.join("\n"), "text/csv", combinedFilename);
}

/**
 * Merge each stream's summary JSON into one { streams: [...] } file instead
 * of making the user download one JSON per leg.
 */
export async function downloadCombinedJson(
  streams: DownloadableStream[],
  combinedFilename: string,
): Promise<void> {
  const combined: Record<string, unknown>[] = [];
  for (const stream of streams) {
    const response = await fetch(resultDownloadUrl(stream.filename, "json"));
    if (!response.ok) {
      continue;
    }
    const summary = await response.json();
    combined.push({ stream: stream.label, ...summary });
  }
  if (combined.length === 0) {
    return;
  }
  triggerBlobDownload(JSON.stringify({ streams: combined }, null, 2), "application/json", combinedFilename);
}

/**
 * Same as downloadCombinedJson, but for callers that already hold the full
 * summary objects in memory (avoids a redundant re-fetch per stream).
 */
export function downloadCombinedJsonFromSummaries(
  streams: { label: string; summary: Record<string, unknown> }[],
  combinedFilename: string,
): void {
  const combined = streams.map(({ label, summary }) => ({ stream: label, ...summary }));
  if (combined.length === 0) {
    return;
  }
  triggerBlobDownload(JSON.stringify({ streams: combined }, null, 2), "application/json", combinedFilename);
}
