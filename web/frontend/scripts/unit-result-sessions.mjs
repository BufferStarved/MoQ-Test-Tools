/**
 * Results history is one row per comparison, not one row per output file.
 */
import assert from "node:assert/strict";

function fileTimeMs(file) {
  const parsed = Date.parse(file.modified_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeSession(key, files) {
  const ordered = [...files].sort((a, b) => (a.stream_index ?? 0) - (b.stream_index ?? 0));
  const modifiedAt = ordered.reduce(
    (latest, file) => (file.modified_at > latest ? file.modified_at : latest),
    ordered[0].modified_at,
  );
  return { key, modifiedAt, files: ordered };
}

function groupResultsIntoSessions(files, clusterWindowMs = 180_000) {
  const groupedByComparison = new Map();
  const ungrouped = [];
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

  const sessions = [];
  for (const [key, groupFiles] of groupedByComparison.entries()) {
    sessions.push(makeSession(key, groupFiles));
  }

  ungrouped.sort((a, b) => fileTimeMs(b) - fileTimeMs(a));
  let bucket = [];
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
    if (Math.abs(bucketKey - ts) <= clusterWindowMs) {
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

const shared = "2026-08-17T23:36:10.690Z";
const lastRun = groupResultsIntoSessions([
  { filename: "a.csv", modified_at: shared, protocol: "moq" },
  { filename: "b.csv", modified_at: "2026-08-17T23:36:10.692Z", protocol: "webrtc" },
  { filename: "c.csv", modified_at: "2026-08-17T23:36:10.701Z", protocol: "moq" },
]);
assert.equal(lastRun.length, 1);
assert.equal(lastRun[0].files.length, 3);

const tagged = groupResultsIntoSessions([
  { filename: "1.csv", modified_at: shared, comparison_id: "cmp-1", stream_index: 1, protocol: "srt" },
  { filename: "0.csv", modified_at: shared, comparison_id: "cmp-1", stream_index: 0, protocol: "moq" },
  { filename: "solo.csv", modified_at: "2026-08-16T12:00:00.000Z", protocol: "rtmp" },
]);
assert.equal(tagged.length, 2);
assert.equal(tagged[0].files.map((f) => f.filename).join(","), "0.csv,1.csv");
assert.equal(tagged[1].files[0].filename, "solo.csv");

console.log("unit-result-sessions: PASS");
