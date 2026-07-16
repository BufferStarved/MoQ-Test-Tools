import type { ResultFile } from "./types";

export interface ResultSession {
  id: string;
  label: string;
  files: string[];
  sortKey: number;
}

const UPLOAD_FILENAME_RE = /^upload_(\d{8})-(\d{6})(?:_[a-f0-9]{8})?\.csv$/;

function parseUploadTimestamp(filename: string): number | null {
  const match = filename.match(UPLOAD_FILENAME_RE);
  if (!match) {
    return null;
  }
  const [, ymd, hms] = match;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6)) - 1;
  const day = Number(ymd.slice(6, 8));
  const hour = Number(hms.slice(0, 2));
  const minute = Number(hms.slice(2, 4));
  const second = Number(hms.slice(4, 6));
  const date = new Date(year, month, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function formatSessionLabel(files: string[], sortKey: number): string {
  const date = new Date(sortKey);
  const stamp = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (files.length > 1) {
    return `Comparison · ${files.length} streams · ${stamp}`;
  }
  return `Run · ${stamp}`;
}

function sortFilesByStreamIndex(results: ResultFile[]): string[] {
  return [...results]
    .sort((a, b) => {
      const indexDelta = (a.stream_index ?? 0) - (b.stream_index ?? 0);
      if (indexDelta !== 0) {
        return indexDelta;
      }
      return a.filename.localeCompare(b.filename);
    })
    .map((result) => result.filename);
}

function buildSession(id: string, results: ResultFile[]): ResultSession {
  const files = sortFilesByStreamIndex(results);
  const sortKey = Math.max(
    ...results.map((result) => parseUploadTimestamp(result.filename) ?? 0),
  );
  return {
    id,
    label: formatSessionLabel(files, sortKey),
    files,
    sortKey,
  };
}

function clusterByTimestamp(results: ResultFile[], clusterWindowMs: number): ResultSession[] {
  const parsed = results
    .map((result) => ({
      result,
      sortKey: parseUploadTimestamp(result.filename),
    }))
    .filter((item): item is { result: ResultFile; sortKey: number } => item.sortKey != null)
    .sort((a, b) => b.sortKey - a.sortKey);

  const sessions: ResultSession[] = [];
  let bucket: ResultFile[] = [];
  let bucketKey = 0;

  for (const item of parsed) {
    if (bucket.length === 0) {
      bucket = [item.result];
      bucketKey = item.sortKey;
      continue;
    }

    if (Math.abs(bucketKey - item.sortKey) <= clusterWindowMs) {
      bucket.push(item.result);
      bucketKey = Math.max(bucketKey, item.sortKey);
      continue;
    }

    sessions.push(buildSession(bucket.map((entry) => entry.filename).join("|"), bucket));
    bucket = [item.result];
    bucketKey = item.sortKey;
  }

  if (bucket.length > 0) {
    sessions.push(buildSession(bucket.map((entry) => entry.filename).join("|"), bucket));
  }

  return sessions;
}

export function groupResultFiles(results: ResultFile[], clusterWindowMs = 120_000): ResultSession[] {
  const groupedByComparison = new Map<string, ResultFile[]>();
  const ungrouped: ResultFile[] = [];

  for (const result of results) {
    if (result.comparison_id) {
      const bucket = groupedByComparison.get(result.comparison_id) ?? [];
      bucket.push(result);
      groupedByComparison.set(result.comparison_id, bucket);
      continue;
    }
    ungrouped.push(result);
  }

  const sessions: ResultSession[] = [];
  for (const [comparisonId, bucket] of groupedByComparison.entries()) {
    sessions.push(buildSession(comparisonId, bucket));
  }

  sessions.push(...clusterByTimestamp(ungrouped, clusterWindowMs));

  const assigned = new Set(sessions.flatMap((session) => session.files));
  for (const result of results) {
    if (assigned.has(result.filename)) {
      continue;
    }
    sessions.push(buildSession(result.filename, [result]));
  }

  return sessions.sort((a, b) => b.sortKey - a.sortKey);
}
