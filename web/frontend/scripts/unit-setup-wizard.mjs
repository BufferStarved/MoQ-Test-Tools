/**
 * Setup stays one section at a time. Recipe labels/order stay; later panes
 * stay hidden until the current decision is confirmed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const wizardSrc = fs.readFileSync(path.join(root, "src/setupWizard.ts"), "utf8");

assert.match(wizardSrc, /setupStepState/);
assert.match(wizardSrc, /firstStepAfterRecipe/);
assert.match(appSrc, /setupCursor/);
assert.match(appSrc, /SetupStepFrame/);
const frameSrc = fs.readFileSync(path.join(root, "src/SetupStepFrame.tsx"), "utf8");
assert.match(frameSrc, /data-setup-step/);
assert.match(appSrc, /setupStepState/);
assert.match(appSrc, /showOutputsPane/);

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(root, "src/setupWizard.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, `setupWizard.test.ts: ${unit.stderr || unit.stdout}`);

console.log("unit-setup-wizard: PASS");
