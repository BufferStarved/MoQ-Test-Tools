import { fetchResultDetail, fetchResults } from "./api";
import type { ResultFile, ResultSummary } from "./types";

export interface SessionGroup {
  /** comparison_id when present, else a clustered/single key. */
  key: string;
  modifiedAt: string;
  files: ResultFile[];
}

const CLUSTER_WINDOW_MS = 180_000;

function fileTimeMs(file: ResultFile): number {
  const parsed = Date.parse(file.modified_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Group saved result files into sessions by comparison_id, then by start time
 * for older browser jobs that never wrote extra.comparison_id. Newest first. */
export function groupResultsIntoSessions(files: ResultFile[]): SessionGroup[] {
  const groupedByComparison = new Map<string, ResultFile[]>();
  const ungrouped: ResultFile[] = [];
  for (const file of files) {
    const comparisonId = file.comparison_id?.trim();
    if (comparisonId) {
      const existing = groupedByComparison.get(comparisonId);
      if (existing) {
        existing.push(file);
      } else {
        groupedByComparison.set(comparisonId, [file]);
      }
      continue;
    }
    ungrouped.push(file);
  }

  const sessions: SessionGroup[] = [];
  for (const [key, groupFiles] of groupedByComparison.entries()) {
    groupFiles.sort((a, b) => (a.stream_index ?? 0) - (b.stream_index ?? 0));
    sessions.push(makeSession(key, groupFiles));
  }

  ungrouped.sort((a, b) => fileTimeMs(b) - fileTimeMs(a));
  let bucket: ResultFile[] = [];
  let bucketKey = 0;
  const flush = () => {
    if (bucket.length === 0) {
      return;
    }
    const key =
      bucket.length === 1
        ? `single:${bucket[0].filename}`
        : `cluster:${bucket.map((file) => file.filename).join("|")}`;
    sessions.push(makeSession(key, bucket));
    bucket = [];
  };
  for (const file of ungrouped) {
    const ts = fileTimeMs(file);
    if (bucket.length === 0) {
      bucket = [file];
      bucketKey = ts;
      continue;
    }
    if (Math.abs(bucketKey - ts) <= CLUSTER_WINDOW_MS) {
      bucket.push(file);
      bucketKey = Math.max(bucketKey, ts);
      continue;
    }
    flush();
    bucket = [file];
    bucketKey = ts;
  }
  flush();

  sessions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return sessions;
}

function makeSession(key: string, files: ResultFile[]): SessionGroup {
  const ordered = [...files].sort((a, b) => (a.stream_index ?? 0) - (b.stream_index ?? 0));
  const modifiedAt = ordered.reduce(
    (latest, file) => (file.modified_at > latest ? file.modified_at : latest),
    ordered[0].modified_at,
  );
  return { key, modifiedAt, files: ordered };
}

export async function loadSessionHistory(): Promise<SessionGroup[]> {
  const { results } = await fetchResults();
  return groupResultsIntoSessions(results);
}

export async function loadSessionSummaries(
  group: SessionGroup,
): Promise<{ summaries: ResultSummary[]; labels: string[] }> {
  const details = await Promise.all(group.files.map((file) => fetchResultDetail(file.filename)));
  const labels = details.map(
    (detail, index) => detail.summary_extra?.stream_label || `Stream ${index + 1} (${detail.protocol.toUpperCase()})`,
  );
  return { summaries: details, labels };
}

export function sessionTimeLabel(isoTimestamp: string): string {
  try {
    return new Date(isoTimestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoTimestamp;
  }
}

export function sessionProtocolSummary(group: SessionGroup): string {
  const protocols = group.files
    .map((file) => (file.protocol || "").trim().toUpperCase())
    .filter((value, index, all) => value && all.indexOf(value) === index);
  if (protocols.length === 0) {
    return `${group.files.length} stream${group.files.length === 1 ? "" : "s"}`;
  }
  return protocols.join(" · ");
}
