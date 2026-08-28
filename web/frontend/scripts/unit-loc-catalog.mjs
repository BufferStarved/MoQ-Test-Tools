/**
 * Browser LOC catalog / live-write helpers. Fake injected catalogs are forbidden.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const loc = fs.readFileSync(path.join(root, "browserMoq/locCatalog.ts"), "utf8");
assert.match(loc, /d18-delta-vi64/);
assert.match(loc, /BROWSER_LOC_CATALOG_GROUP = 0n/);
assert.match(loc, /locCatalogTrackShouldEnd/);

const publisher = fs.readFileSync(path.join(root, "browserMoq/moq5Service.ts"), "utf8");
assert.match(publisher, /connection\.publish\(/);
assert.match(publisher, /onFetch/);
assert.match(publisher, /browserLocHeaderOptions/);
assert.match(publisher, /BROWSER_LOC_CATALOG_GROUP/);
assert.match(publisher, /waitPublishOk/);
assert.doesNotMatch(publisher, /deltaEncoded: true/);
assert.doesNotMatch(
  publisher,
  /publishDone\(requestId, PublishDoneCode\.TRACK_ENDED/,
);

const player = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(player, /knownTracks/);
assert.match(player, /no injected catalog/);

for (const testFile of ["browserMoq/locCatalog.test.ts", "browserMoq/locPublish.test.ts"]) {
  const full = path.join(root, testFile);
  if (!fs.existsSync(full)) {
    continue;
  }
  const unit = spawnSync(
    process.execPath,
    ["--test", "--experimental-strip-types", full],
    { encoding: "utf8" },
  );
  assert.equal(unit.status, 0, `${testFile}: ${unit.stderr || unit.stdout}`);
}

console.log("unit-loc-catalog: PASS");
