import { fetchResultDetail, fetchResults } from "./api";
import type { ResultFile, ResultSummary } from "./types";

export interface SessionGroup {
  /** comparison_id when present, else the filename (singleton legacy runs). */
  key: string;
  modifiedAt: string;
  files: ResultFile[];
}

/** Group saved result files into sessions by comparison_id (falling back to a
 * singleton group per file for older runs saved before that field existed),
 * newest first. */
export function groupResultsIntoSessions(files: ResultFile[]): SessionGroup[] {
  const groups = new Map<string, ResultFile[]>();
  for (const file of files) {
    const key = file.comparison_id?.trim() || `single:${file.filename}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(file);
    } else {
      groups.set(key, [file]);
    }
  }

  const sessions: SessionGroup[] = [];
  for (const [key, groupFiles] of groups) {
    groupFiles.sort((a, b) => (a.stream_index ?? 0) - (b.stream_index ?? 0));
    const modifiedAt = groupFiles.reduce(
      (latest, file) => (file.modified_at > latest ? file.modified_at : latest),
      groupFiles[0].modified_at,
    );
    sessions.push({ key, modifiedAt, files: groupFiles });
  }

  sessions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return sessions;
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
