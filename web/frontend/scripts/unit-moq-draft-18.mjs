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
assert.match(recorder, /record-policy\.mjs/);
assert.match(recorder, /reconnect on 0x10 \/ §11\.1/);
assert.doesNotMatch(recorder, /no objects for 5s; resubscribing/);
assert.doesNotMatch(recorder, /filter: \{ type: 'LargestObject' \}/);

const ingest = fs.readFileSync(path.join(root, "ingestEndpoints.ts"), "utf8");
assert.match(ingest, /protocol === "moq"\s*\n\s*\? \(`\$\{prefix\}_moq_relay_d18`/);
assert.match(ingest, /label: "GCP Central"/);
assert.match(ingest, /label: "GCP East"/);
assert.match(ingest, /label: "Linode East"/);
assert.match(ingest, /labelPrefix: "OpenMOQ"/);
assert.match(ingest, /labelPrefix: "OpenMOQ draft-16"/);
assert.match(ingest, /\$\{role\.labelPrefix\} · \$\{host\.label\}/);
assert.match(ingest, /ingestPrefix: "gcp"/);
assert.match(ingest, /RECIPE_HIDDEN_INGEST_IDS[\s\S]*moq_relay/);
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
assert.match(helper, /isPublicOrchestrator/);
assert.match(helper, /moq\.sean-mccarthy\.net/);
assert.doesNotMatch(helper, /git clone --branch feat\/moq-draft-18/);
assert.doesNotMatch(helper, /LOCAL_PUBLISHER_API=\$\{api\}.*sean-mccarthy/);
const setup = fs.readFileSync(path.join(root, "LocalPublisherSetup.tsx"), "utf8");
assert.match(setup, /not a shared operator webcam/);
assert.match(setup, /isPublicOrchestrator/);
assert.doesNotMatch(setup, /Laptop helper/);
assert.doesNotMatch(setup, /Laptop webcam encode is not available on the public site/);
assert.doesNotMatch(setup, /LOCAL_PUBLISHER_API=https:\/\/moq/);
const source = fs.readFileSync(path.join(root, "SourceSection.tsx"), "utf8");
assert.doesNotMatch(source, /LocalPublisherSetup/);
assert.match(source, /helper command is under Encode/);

const dest = fs.readFileSync(path.join(root, "../../../src/destinations.py"), "utf8");
assert.match(dest, /moq_gcp_relay_d18/);
assert.match(dest, /relay_d18/);
assert.match(dest, /:14433/);
assert.match(dest, /draft=18/);
assert.match(dest, /id=f"moq_\{slug\}_relay_d18"/);
assert.match(dest, /https:\/\/\{relay_domain\}:14433\/moq-relay\?namespace=benchmark&draft=18/);
assert.doesNotMatch(dest, /url=f"https:\/\/\{relay_domain\}:4433\/moq-relay\?namespace=benchmark&draft=18"/);

console.log("unit-moq-draft-18: PASS");
