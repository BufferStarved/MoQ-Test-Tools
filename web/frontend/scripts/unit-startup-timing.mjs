/**
 * Player-side startup collection: the browser's four startup phases must reach
 * the CSV as blanks when unmeasured, and the whole chain has to exist on both
 * sides of the wire.
 *
 * Motivating case: the RTMP startup win already banked (23s -> 1501 ms) was
 * found by reasoning about phases nothing in the tool measured. The one way to
 * lose that again is to report a phase with no instrument as 0 — it then charts
 * and sums exactly like a phase that was genuinely instant, and the residual
 * shrinks to match a stage nobody observed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const PLAYER_PHASES = [
  "startup_player_request_ms",
  "startup_manifest_ms",
  "startup_first_media_ms",
  "startup_first_paint_ms",
];

// The contract, the browser mirror, and every hop between them.
const pyBudget = fs.readFileSync(path.join(repoRoot, "src/startup_budget.py"), "utf8");
const pyMetrics = fs.readFileSync(path.join(repoRoot, "src/metrics.py"), "utf8");
const pyPlayback = fs.readFileSync(path.join(repoRoot, "src/playback_metrics.py"), "utf8");
const api = fs.readFileSync(path.join(root, "api.ts"), "utf8");
const reporter = fs.readFileSync(path.join(root, "playbackMetrics.ts"), "utf8");
const types = fs.readFileSync(path.join(root, "types.ts"), "utf8");
const apiMain = fs.readFileSync(path.join(repoRoot, "web/api/main.py"), "utf8");
const jobManager = fs.readFileSync(path.join(repoRoot, "web/api/job_manager.py"), "utf8");

for (const name of PLAYER_PHASES) {
  assert.match(pyBudget, new RegExp(name), `${name} missing from startup_budget.py`);
  assert.match(pyMetrics, new RegExp(`"${name}"`), `${name} missing from CSV_COLUMNS`);
  assert.match(pyPlayback, new RegExp(name), `${name} not persisted by the playback merge`);
  assert.match(api, new RegExp(`${name}\\?`), `${name} missing from PlaybackMetricsSnapshot`);
  assert.match(reporter, new RegExp(`${name}:`), `${name} not in the posted playback sample`);
  assert.match(types, new RegExp(`${name}\\?`), `${name} missing from UploadSample`);
  assert.match(apiMain, new RegExp(`${name}: Optional\\[float\\] = None`), `${name} defaults to 0 in the API`);
}

// A phase with no instrument must travel as an explicit null the whole way.
// `?? 0` in the reporter, or a `= 0.0` Pydantic default, converts "nothing
// measures this" into "measured, and it was free" before the CSV ever sees it.
const posted = reporter.slice(reporter.indexOf("startup_player_request_ms:"));
assert.ok(
  !/startup_\w+_ms:\s*[\w.]+\s*\?\?\s*0\b/.test(posted),
  "startup phases must be posted as null, never coerced to 0",
);
assert.match(pyPlayback, /PLAYBACK_NULLABLE_KEYS/, "blank-preserving key set missing");
// Defaulting them alongside the counters is exactly the coercion this guards.
const defaults = pyPlayback.slice(pyPlayback.indexOf("PLAYBACK_DEFAULTS ="));
assert.match(
  defaults.slice(0, 200),
  /PLAYBACK_NUMERIC_FIELD_NAMES/,
  'PLAYBACK_DEFAULTS must not put "0" on the nullable startup columns',
);
// One-shot join facts, not live gauges: blanking them when the player detaches
// would erase how the join was spent from every row after it.
const liveGauges = pyPlayback.slice(
  pyPlayback.indexOf("PLAYBACK_LIVE_GAUGE_KEYS = ("),
  pyPlayback.indexOf("PLAYBACK_STALE_AFTER_SEC"),
);
for (const name of PLAYER_PHASES) {
  assert.ok(!liveGauges.includes(name), `${name} must not be a live gauge`);
}
assert.match(jobManager, /PLAYBACK_NULLABLE_KEYS/, "API sample intake still defaults phases to 0");

// Per-engine collection. Each player has to feed the phases from its own
// instruments; a player that silently reports none is indistinguishable in the
// CSV from one whose phases were all unmeasurable.
for (const player of ["HlsPlayer", "DashPlayer", "MpegTsPlayer", "WhepPlayer", "MoqPlayer"]) {
  const source = fs.readFileSync(path.join(root, `players/${player}.tsx`), "utf8");
  assert.match(source, /startupTiming/, `${player} does not collect startup phases`);
  assert.match(source, /startupPhasesRef|startupPhases\(\)/, `${player} does not report startup phases`);
}
// MPEG-TS has no manifest at all — the phase is structurally absent, not 0.
const mpegts = fs.readFileSync(path.join(root, "players/MpegTsPlayer.tsx"), "utf8");
assert.match(mpegts, /manifestApplicable: false/, "raw MPEG-TS must report no manifest phase");
// MoQ is the one engine that instruments every milestone itself.
const moq = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(moq, /startupPhasesFromPlayaBreakdown/, "MoQ must forward playa's TTFF breakdown");

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(root, "startupTiming.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, `startupTiming.test.ts: ${unit.stderr || unit.stdout}`);

console.log("unit-startup-timing: PASS");
