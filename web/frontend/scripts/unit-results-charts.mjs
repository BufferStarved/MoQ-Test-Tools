/**
 * Guard: Results chart builders must survive empty / 2-of-4 / mid-stop sessions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(frontend, "src");

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(src, "chartData.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, unit.stderr || unit.stdout);

console.log("unit-results-charts: ok");
