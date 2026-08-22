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
assert.match(service, /const DEFAULT_RELAY_DRAFT: MoqtDraftVersion = 18/);
assert.match(service, /draft18Opts/);

const player = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(player, /draftVersion = 18/);

const recorder = fs.readFileSync(
  path.join(root, "../../../tools/openmoq-recorder/record.mjs"),
  "utf8",
);
assert.match(recorder, /protocols: \['moqt-18'\]/);
assert.match(recorder, /new MoqtConnection\(18\)/);

const ingest = fs.readFileSync(path.join(root, "ingestEndpoints.ts"), "utf8");
assert.match(ingest, /protocol === "moq"\s*\n\s*\? \(`\$\{prefix\}_moq_relay_d18`/);
assert.match(ingest, /label: "OpenMOQ · GCP us-central1"/);
assert.match(ingest, /label: "OpenMOQ · GCP us-east1"/);
assert.match(ingest, /label: "OpenMOQ · Linode"/);
assert.match(ingest, /OpenMOQ draft-16 · GCP us-central1/);
assert.match(ingest, /"gcp_moq_relay"/);
assert.match(ingest, /RECIPE_HIDDEN_INGEST_IDS[\s\S]*gcp_moq_relay/);
assert.match(ingest, /RECIPE_HIDDEN_INGEST_IDS[\s\S]*linode_moq_relay/);
for (const label of ingest.match(/label: "OpenMOQ · [^"]+"/g) || []) {
  assert.doesNotMatch(label, /:4433/);
  assert.doesNotMatch(label, /draft-16/);
}
assert.match(ingest, /moq_relay_d18[\s\S]*:4433[\s\S]*:14433/);
assert.match(
  ingest,
  /export function moqPinTlsCertForIngest[\s\S]*return !ingestEndpointId.includes\("moq_relay_d18"\)/,
);

const harness = fs.readFileSync(path.join(root, "HarnessPage.tsx"), "utf8");
assert.match(harness, /moqPinTlsCert=\{moqPinTlsCertForIngest\(ingestEndpointId\)\}/);
assert.match(harness, /moqDraftVersion=\{moqDraftForIngest\(ingestEndpointId\)\}/);

const streamPlayer = fs.readFileSync(path.join(root, "StreamPlayer.tsx"), "utf8");
assert.match(streamPlayer, /moqPinTlsCert \?\? moqPinTlsCertForIngest\(ingestEndpointId\)/);
assert.doesNotMatch(streamPlayer, /moqPinTlsCert = true/);

const helper = fs.readFileSync(path.join(root, "localPublisherHelp.ts"), "utf8");
assert.match(helper, /localPublisherAgentD18Command/);
assert.match(helper, /feat\/moq-draft-18/);
assert.match(helper, /MoQ-Test-Tools-d18/);
assert.match(helper, /install-moq5\.sh/);
assert.match(helper, /return localPublisherAgentCommand/);
assert.doesNotMatch(helper, /git clone \$\{GH_REPO\}\.git 2>\/dev\/null \|\| git -C MoQ-Test-Tools pull/);
assert.equal(
  (helper.match(/git clone --branch feat\/moq-draft-18/g) || []).length,
  1,
  "exactly one hosted helper clone",
);
const setup = fs.readFileSync(path.join(root, "LocalPublisherSetup.tsx"), "utf8");
assert.match(setup, /Laptop helper/);
assert.match(setup, /One helper covers MoQ draft-18/);
assert.match(setup, /SRT \/ RTMP \/ WebRTC/);
assert.doesNotMatch(setup, /title="SRT \/ RTMP \/ WebRTC"/);

const dest = fs.readFileSync(path.join(root, "../../../src/destinations.py"), "utf8");
const d18Blocks = dest.split("ServicePreset(").filter((block) => /id="[^"]*_d18"/.test(block));
assert.ok(d18Blocks.length >= 3, "expected west/east/linode d18 presets");
for (const block of d18Blocks) {
  assert.match(block, /:14433/);
  assert.match(block, /draft=18/);
  assert.doesNotMatch(block, /url=.*:4433/);
}

console.log("unit-moq-draft-18: PASS");
