/**
 * Nine-host ingest grid: exact labels, :14433 only, undeployed stay visible.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ingest = fs.readFileSync(path.join(root, "src/ingestEndpoints.ts"), "utf8");
const endpoint = fs.readFileSync(path.join(root, "src/EndpointSection.tsx"), "utf8");
const destGrid = fs.readFileSync(path.join(root, "src/DestinationGrid.tsx"), "utf8");
const destModel = fs.readFileSync(path.join(root, "src/destinationGridModel.ts"), "utf8");
const placement = fs.readFileSync(path.join(root, "../../src/cloud_placement.py"), "utf8");

for (const label of [
  "GCP East",
  "GCP Central",
  "GCP West",
  "Linode East",
  "Linode Central",
  "Linode West",
  "AWS East",
  "AWS Central",
  "AWS West",
]) {
  assert.match(ingest, new RegExp(`label: "${label}"`));
  assert.match(placement, new RegExp(`label="${label}"`));
}

assert.match(ingest, /cloudRegion: "us-west1"/);
assert.match(ingest, /cloudRegion: "us-central"/);
assert.match(ingest, /cloudRegion: "us-east-2"/);
assert.match(ingest, /Dallas/);
assert.match(ingest, /:14433/);
assert.match(ingest, /Not deployed/);
assert.match(destModel, /Not deployed/);
assert.match(destGrid, /unavailableDestLabel/);
assert.match(endpoint, /DestinationGrid/);
assert.match(destGrid, /disabled=\{disabled \|\| \(!item\.available/);
assert.doesNotMatch(ingest, /label: "OpenMOQ · GCP us-central1"/);

const unit = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", path.join(root, "src/ingestEndpoints.test.ts")],
  { encoding: "utf8" },
);
assert.equal(unit.status, 0, `ingestEndpoints.test.ts: ${unit.stderr || unit.stdout}`);
console.log("unit-ingest-hosts: PASS");
