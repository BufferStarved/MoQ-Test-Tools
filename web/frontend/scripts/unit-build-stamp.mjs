/**
 * Guard: the always-visible build stamp stays wired into the SPA and health API.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(frontend, "src");

const mainSrc = fs.readFileSync(path.join(src, "main.tsx"), "utf8");
assert.match(mainSrc, /<BuildStamp\s*\/>/);

const viteSrc = fs.readFileSync(path.join(frontend, "vite.config.ts"), "utf8");
assert.match(viteSrc, /VITE_GIT_SHA/);

const apiSrc = fs.readFileSync(path.join(frontend, "../api/main.py"), "utf8");
assert.match(apiSrc, /git_sha/);
assert.match(apiSrc, /Cache-Control.*no-store/);

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(src, "buildStamp.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, unit.stderr || unit.stdout);

console.log("unit-build-stamp: ok");
