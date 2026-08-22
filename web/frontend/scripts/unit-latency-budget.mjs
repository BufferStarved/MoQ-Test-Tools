/**
 * Latency decomposition: browser mirror must stay numerically identical to
 * src/latency_budget.py, and every component must be wired into the UI
 * (definitions, protocol support, chart group, sample type).
 *
 * Motivating run: comparison 2026-08-22 — RTMP→Linode Zixi TTFF ~23s and
 * WebRTC 8 stalls / 28s rebuffer both showed up as a single large e2e number
 * with no way to tell which stage was responsible.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const COMPONENTS = [
  "latency_encode_ms",
  "latency_publish_ms",
  "latency_network_ms",
  "latency_packager_ms",
  "latency_player_buffer_ms",
];
const DERIVED = ["latency_accounted_ms", "latency_residual_ms", "latency_overcount_ms"];
// Self-describing columns: which stages had no instrument, and which span the
// leg's e2e actually covers. Not numeric series, so they are not charted, but
// they must exist everywhere else or the numeric columns lose their meaning.
const ANNOTATIONS = ["latency_unmeasured", "latency_e2e_scope"];
const FRAME_COLUMNS = [
  "encode_frames_total",
  "encode_frames_dropped",
  "encode_frames_duped",
  "encode_frame_drop_pct",
  "playback_frame_drop_pct",
  "frame_delivery_pct",
];

// Python and TS must agree on the column set, or a CSV column silently has no
// UI meaning (and vice versa).
const pyBudget = fs.readFileSync(path.join(repoRoot, "src/latency_budget.py"), "utf8");
for (const name of [...COMPONENTS, ...DERIVED, ...ANNOTATIONS]) {
  assert.match(pyBudget, new RegExp(name), `${name} missing from latency_budget.py`);
}
const pyMetrics = fs.readFileSync(path.join(repoRoot, "src/metrics.py"), "utf8");
for (const name of [...COMPONENTS, ...DERIVED, ...ANNOTATIONS, ...FRAME_COLUMNS]) {
  assert.match(pyMetrics, new RegExp(`"${name}"`), `${name} missing from CSV_COLUMNS`);
}

const ts = fs.readFileSync(path.join(root, "latencyBudget.ts"), "utf8");
for (const name of COMPONENTS) {
  assert.match(ts, new RegExp(name), `${name} missing from latencyBudget.ts`);
}

// The two halves of the reconciliation must exist on both sides, or one of
// them silently stops being reported and the model goes back to hiding
// over-attribution behind a clamped residual.
for (const source of [pyBudget, ts]) {
  assert.match(source, /overcount/i, "signed over-attribution missing");
  assert.match(source, /ingest_to_glass/, "e2e scope missing");
}

// Every new column needs operator-facing copy, or the UI shows a bare number.
const definitions = fs.readFileSync(path.join(root, "metricDefinitions.ts"), "utf8");
for (const name of [...COMPONENTS, ...DERIVED, ...ANNOTATIONS, ...FRAME_COLUMNS]) {
  assert.match(definitions, new RegExp(`\\b${name}:`), `${name} has no metric definition`);
}
// The packager copy blamed "Zixi chunk packaging" for the residual while the
// packager column read 0, which does not reconcile. It has to say the stage is
// unmeasured there, not free.
const packagerCopy = definitions.slice(definitions.indexOf("latency_packager_ms:"));
assert.match(
  packagerCopy.slice(0, 1200),
  /unmeasured|no instrument/i,
  "packager copy must say the stage is unmeasured on Zixi, not zero",
);

// And a declared protocol-support row, so unavailable stages say why.
const model = fs.readFileSync(path.join(root, "metricModel.ts"), "utf8");
for (const name of [...COMPONENTS, ...DERIVED, ...ANNOTATIONS, ...FRAME_COLUMNS]) {
  assert.match(model, new RegExp(`\\b${name}:`), `${name} missing protocol support`);
}
// The packager stage is only measurable where a packager stamps a wall clock.
assert.match(model, /latency_packager_ms: \["srt", "rtmp", "hls", "dash"\]/);
// MoQ has no RTT source wired, so it must not claim a network component.
assert.match(model, /latency_network_ms: \["srt", "rtmp", "webrtc"\]/);

// MoQ LOC's "behind live" seconds point the opposite way from a player buffer
// and must never reach the buffer column that the latency chain consumes.
const moqPlayer = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(
  moqPlayer,
  /playback_behind_live_sec: loc\s*\n?\s*\? canvasBehindLiveSec/,
  "MoQ LOC behind-live must be reported separately from playback_buffer_sec",
);
assert.match(
  moqPlayer,
  /playback_buffer_sec: bufferedAheadSec\(videoRef\.current\)/,
  "playback_buffer_sec must stay strictly seconds queued ahead",
);
const pyPlayback = fs.readFileSync(path.join(repoRoot, "src/playback_metrics.py"), "utf8");
assert.match(pyPlayback, /playback_behind_live_sec/, "behind-live column not persisted");
// Forward-filling past the player's last report made a detached leg look
// steady; the age column is what tells the two apart.
assert.match(pyPlayback, /playback_sample_age_sec/, "staleness signal missing");

// Charted in pipeline order under its own group.
const charts = fs.readFileSync(path.join(root, "chartData.ts"), "utf8");
assert.match(charts, /id: "latency_budget"/);
const budgetGroup = charts.slice(charts.indexOf('id: "latency_budget"'));
const chartedOrder = COMPONENTS.map((key) => budgetGroup.indexOf(key));
for (let i = 1; i < chartedOrder.length; i += 1) {
  assert.ok(chartedOrder[i] > chartedOrder[i - 1], "latency components must chart in chain order");
  assert.ok(chartedOrder[i] > 0, `${COMPONENTS[i]} not charted`);
}

// Streamed live, not only written to the CSV at the end of a run.
const types = fs.readFileSync(path.join(root, "types.ts"), "utf8");
for (const name of [...COMPONENTS, ...DERIVED, ...FRAME_COLUMNS]) {
  assert.match(types, new RegExp(`${name}\\?`), `${name} missing from UploadSample`);
}
const uploadService = fs.readFileSync(path.join(repoRoot, "src/upload_service.py"), "utf8");
assert.match(uploadService, /_apply_latency_budget/);

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(root, "latencyBudget.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, `latencyBudget.test.ts: ${unit.stderr || unit.stdout}`);

console.log("unit-latency-budget: PASS");
