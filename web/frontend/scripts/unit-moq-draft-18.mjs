/**
 * This branch defaults the MoQ pipeline to draft-18.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const versions = fs.readFileSync(path.join(root, "browserMoq/moqtVersions.ts"), "utf8");
assert.match(versions, /export const NEWEST_MOQT_DRAFT = 18/);
assert.match(versions, /MOQT_DRAFTS_RELAY_FIRST = \[18\]/);

const service = fs.readFileSync(path.join(root, "browserMoq/moq5Service.ts"), "utf8");
assert.match(service, /const RELAY_DRAFT: MoqtDraftVersion = 18/);
assert.match(service, /draft-18/);

const player = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(player, /draftVersion = 18/);

const recorder = fs.readFileSync(
  path.join(root, "../../../tools/openmoq-recorder/record.mjs"),
  "utf8",
);
assert.match(recorder, /protocols: \['moqt-18'\]/);
assert.match(recorder, /new MoqtConnection\(18\)/);

console.log("unit-moq-draft-18: PASS");
