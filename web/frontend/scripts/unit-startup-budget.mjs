/**
 * Startup decomposition: the browser mirror must stay identical to
 * src/startup_budget.py, and every column must be wired all the way through
 * the UI (definitions, protocol support, chart group, chart-point mapping,
 * render block).
 *
 * The wiring half of this gate is not paranoia. `latency_budget` shipped with a
 * CHART_GROUPS entry, no render block in ResultCharts.tsx, and no `latency_*`
 * keys in rowsToChartPoints() — so its tab renders an empty grid and its
 * series have no data to find. A mirror that drifts and a column that is
 * charted nowhere fail the same way: the number exists and means nothing.
 *
 * Motivating case: RTMP time-to-first-frame 23s → 1501 ms, found by reasoning
 * about phases because no column measured them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(frontend, "src");
const repoRoot = path.resolve(frontend, "../..");

const PUBLISHER_COMPONENTS = [
  "startup_dns_ms",
  "startup_connect_ms",
  "startup_handshake_ms",
  "startup_publish_accept_ms",
  "startup_first_idr_ms",
  "startup_first_byte_ingest_ms",
];
const PLAYER_COMPONENTS = [
  "startup_player_request_ms",
  "startup_manifest_ms",
  "startup_first_media_ms",
  "startup_first_paint_ms",
];
const COMPONENTS = [...PUBLISHER_COMPONENTS, ...PLAYER_COMPONENTS];
const DERIVED = [
  "startup_publisher_accounted_ms",
  "startup_publisher_measured_ms",
  "startup_publisher_residual_ms",
  "startup_publisher_overcount_ms",
  "startup_player_accounted_ms",
  "startup_player_measured_ms",
  "startup_player_residual_ms",
  "startup_player_overcount_ms",
];
// Self-describing columns: which phases had no instrument, and which cannot
// exist here at all. Stage-name lists rather than numeric series, so they are
// not charted — but without them a blank phase is indistinguishable from a
// phase that was never going to have a number.
const ANNOTATIONS = ["startup_unmeasured", "startup_not_applicable"];
const ALL_COLUMNS = [...COMPONENTS, ...DERIVED, ...ANNOTATIONS];

assert.equal(ALL_COLUMNS.length, 20, "the family is 20 columns");

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

// ---------------------------------------------------------------------------
// Python contract ↔ CSV
// ---------------------------------------------------------------------------

const pyBudget = read(repoRoot, "src/startup_budget.py");
for (const name of ALL_COLUMNS) {
  assert.match(pyBudget, new RegExp(`"${name}"`), `${name} missing from startup_budget.py`);
}
const pyMetrics = read(repoRoot, "src/metrics.py");
for (const name of ALL_COLUMNS) {
  assert.match(pyMetrics, new RegExp(`"${name}"`), `${name} missing from CSV_COLUMNS`);
}

// The two chains must stay two chains on both sides. A single joined total
// would be dominated by the operator's dwell before opening the player tile.
const ts = read(src, "startupBudget.ts");
for (const source of [pyBudget, ts]) {
  assert.match(source, /overcount/i, "signed over-attribution missing");
  assert.match(source, /not_applicable|notApplicable/, "the third state is missing");
}
assert.ok(
  !/startup_total_ms|startup_joined/.test(pyBudget + ts),
  "the publisher and player chains must not be summed into one total",
);

// ---------------------------------------------------------------------------
// TS mirror
// ---------------------------------------------------------------------------

for (const name of ALL_COLUMNS) {
  assert.match(ts, new RegExp(name), `${name} missing from startupBudget.ts`);
}
// Chain order is load-bearing: it is what accounted_ms sums and what the UI
// stacks, so the mirror must not reorder the phases.
const tsOrder = COMPONENTS.map((name) => ts.indexOf(`"${name}"`));
for (let i = 1; i < tsOrder.length; i += 1) {
  assert.ok(tsOrder[i] > 0, `${COMPONENTS[i]} not declared in startupBudget.ts`);
  assert.ok(tsOrder[i] > tsOrder[i - 1], `${COMPONENTS[i]} is out of chain order in the mirror`);
}
// The per-protocol / per-engine tables are the normalization work; two
// protocols reporting startup_handshake_ms must be reporting comparable
// things. They are copied verbatim from the Python, so a spot check that they
// exist on both sides catches a mirror that dropped them.
for (const source of [pyBudget, ts]) {
  assert.match(source, /PROTOCOL_PHASE_NOTES/, "per-protocol phase table missing");
  assert.match(source, /PLAYER_PHASE_NOTES/, "per-engine phase table missing");
  assert.match(source, /caller handshake/, "SRT connect-is-handshake note missing");
}
for (const engine of ["hls:", '"ll-hls":', "mpegts:", "whep:", "moq:", "dash:"]) {
  assert.ok(ts.includes(engine), `player engine ${engine} missing from the mirror`);
}
for (const protocol of ["rtmp:", "srt:", "webrtc:", "moq:"]) {
  assert.ok(ts.includes(protocol), `protocol ${protocol} missing from the mirror`);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

// Operator-facing copy, or the UI shows a bare number.
const definitions = read(src, "metricDefinitions.ts");
for (const name of ALL_COLUMNS) {
  assert.match(definitions, new RegExp(`\\b${name}:`), `${name} has no metric definition`);
}
// The copy has to carry the per-protocol mapping, or the column invites a
// cross-protocol comparison that is a category error.
const connectCopy = definitions.slice(definitions.indexOf("startup_connect_ms:"), definitions.indexOf("startup_handshake_ms:"));
assert.match(connectCopy, /SRT: not applicable/, "connect copy must say SRT has no connect phase");
const manifestCopy = definitions.slice(definitions.indexOf("startup_manifest_ms:"), definitions.indexOf("startup_first_media_ms:"));
assert.match(manifestCopy, /not applicable/, "manifest copy must say MPEG-TS has no manifest");
// Blank, zero and not-applicable are three facts; the annotation copy is where
// an operator learns they are not the same one.
const unmeasuredCopy = definitions.slice(definitions.indexOf("startup_unmeasured:"));
assert.match(unmeasuredCopy.slice(0, 1600), /measured, and it was zero/, "blank-vs-zero copy missing");

// Declared protocol support, so an unavailable phase says why.
const model = read(src, "metricModel.ts");
for (const name of ALL_COLUMNS) {
  assert.match(model, new RegExp(`\\b${name}:`), `${name} missing protocol support`);
}
// SRT is excluded from `connect` because the phase does not exist there — not
// because it is unwired. Marking it supported would promise an instrument.
assert.match(model, /startup_connect_ms: \["rtmp", "webrtc", "moq"\]/);
assert.match(model, /startup_handshake_ms: \["srt", "rtmp", "webrtc", "moq"\]/);
// The player half is keyed on the engine, and any protocol can be watched in
// the site player, so restricting these by protocol would be wrong.
for (const name of PLAYER_COMPONENTS) {
  assert.match(
    model,
    new RegExp(`${name}: \\["srt", "rtmp", "http", "hls", "dash", "webrtc", "moq"\\]`),
    `${name} must not be restricted by publish protocol`,
  );
}

// Charted under its own group, in chain order.
const charts = read(src, "chartData.ts");
assert.match(charts, /id: "startup_breakdown"/);
assert.match(charts, /title: "Startup breakdown"/);
const group = charts.slice(charts.indexOf('id: "startup_breakdown"'));
const chartedOrder = COMPONENTS.map((name) => group.indexOf(`"${name}"`));
for (let i = 1; i < chartedOrder.length; i += 1) {
  assert.ok(chartedOrder[i] > 0, `${COMPONENTS[i]} not charted`);
  assert.ok(chartedOrder[i] > chartedOrder[i - 1], "startup phases must chart in chain order");
}
for (const name of DERIVED) {
  assert.ok(group.includes(`"${name}"`), `${name} not charted`);
}

// A group whose keys are never written into a chart point renders an empty
// grid — the live `latency_budget` bug. Both builders must map them.
assert.match(charts, /startupRowMetrics/, "CSV rows do not map the startup columns");
assert.match(charts, /startupSampleMetrics/, "live samples do not map the startup columns");
assert.match(charts, /\.\.\.startupRowMetrics\(row\)/, "rowsToChartPoints must spread the mapping");
assert.match(
  charts,
  /\.\.\.startupSampleMetrics\(sample\)/,
  "normalizeSamplePoint must spread the mapping",
);

// And an actual render block, for the same reason.
const resultCharts = read(src, "ResultCharts.tsx");
assert.match(
  resultCharts,
  /currentGroup\.id === "startup_breakdown"/,
  "the Startup breakdown tab has no render block",
);
assert.match(resultCharts, /<StartupBreakdown/, "the breakdown view is not rendered");

// The view must read the row/sample directly: ChartPoint is all-numbers and
// cannot carry "blank", which is the one distinction this family is about.
const view = read(src, "StartupBreakdown.tsx");
assert.match(view, /startupBudgetFromColumns/, "the view must rebuild from the raw columns");
assert.match(view, /startupBudgetShares/, "the view must use the stacked-share helper");
// Unmeasured and not-applicable have to look different from a measured 0.
assert.match(view, /repeating-linear-gradient/, "unmeasured phases need a distinct fill");
assert.match(view, /dashed/, "not-applicable phases need a distinct outline");
assert.match(view, /Unattributed|residual/i, "the residual needs an explicit segment");

// Documented, including the per-protocol and per-engine mapping tables.
const docs = read(repoRoot, "docs/METRICS.md");
assert.match(docs, /## Startup breakdown/, "docs/METRICS.md has no startup section");
for (const name of ALL_COLUMNS) {
  assert.ok(docs.includes(name), `${name} undocumented in docs/METRICS.md`);
}
assert.match(docs, /23s → 1501 ms/, "the motivating RTMP case is not cited");
assert.match(docs, /two spans, not one/i, "the docs must say the chains are not summed");

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(src, "startupBudget.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, `startupBudget.test.ts: ${unit.stderr || unit.stdout}`);

console.log("unit-startup-budget: PASS");
