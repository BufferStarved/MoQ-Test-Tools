import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOUD_ENCODE_HOST_IDS,
  ENCODE_HOSTS,
  RECIPE_HIDDEN_INGEST_IDS,
  cloudHostFromIngest,
  defaultIngestForProtocol,
  ingestEndpointsForProtocol,
  ingestEndpointsFromPresets,
  ingestPrefixForCloudHost,
  normalizeCloudHost,
} from "./ingestEndpoints.ts";
import type { Preset } from "./types.ts";

function stubPreset(id: string, available = true): Preset {
  return {
    id,
    name: id,
    protocol: "srt",
    notes: available ? "" : "Not deployed",
    env_vars: [],
    requires_env: false,
    web_available: available,
  };
}

describe("9-host encode registry", () => {
  it("lists GCP / Linode / AWS × East / Central / West with exact labels", () => {
    assert.deepEqual(
      ENCODE_HOSTS.map((host) => [host.id, host.label, host.cloudRegion]),
      [
        ["gcp_east", "GCP East", "us-east1"],
        ["gcp_central", "GCP Central", "us-central1"],
        ["gcp_west", "GCP West", "us-west1"],
        ["linode_east", "Linode East", "us-east"],
        ["linode_central", "Linode Central", "us-central"],
        ["linode_west", "Linode West", "us-west"],
        ["aws_east", "AWS East", "us-east-1"],
        ["aws_central", "AWS Central", "us-east-2"],
        ["aws_west", "AWS West", "us-west-2"],
      ],
    );
    assert.equal(CLOUD_ENCODE_HOST_IDS.length, 9);
    assert.equal(normalizeCloudHost("gcp"), "gcp_central");
    assert.equal(normalizeCloudHost("linode"), "linode_east");
    assert.match(ENCODE_HOSTS.find((host) => host.id === "linode_central")?.subtitle ?? "", /Dallas/);
  });

  it("keeps live ingest prefixes and maps leftover :4433 as hidden", () => {
    assert.equal(ingestPrefixForCloudHost("gcp_central"), "gcp");
    assert.equal(ingestPrefixForCloudHost("linode_east"), "linode");
    assert.equal(cloudHostFromIngest("gcp_zixi"), "gcp_central");
    assert.equal(cloudHostFromIngest("gcp_east_mediamtx"), "gcp_east");
    assert.equal(cloudHostFromIngest("gcp_west_moq_relay_d18"), "gcp_west");
    assert.equal(cloudHostFromIngest("linode_central_zixi"), "linode_central");
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has("gcp_moq_relay"), true);
    assert.equal(RECIPE_HIDDEN_INGEST_IDS.has("gcp_moq_relay_d18"), false);
    for (const host of ENCODE_HOSTS) {
      const ingest = defaultIngestForProtocol("moq", host.id);
      assert.ok(ingest.endsWith("_moq_relay_d18"), ingest);
      assert.equal(RECIPE_HIDDEN_INGEST_IDS.has(ingest), false);
    }
  });

  it("shows undeployed hosts in the picker as Not deployed, never leftover :4433", () => {
    const presets = [
      stubPreset("moq_zixi_gcp"),
      stubPreset("moq_mediamtx_gcp_srt"),
      stubPreset("moq_gcp_relay_d18"),
      stubPreset("moq_zixi_gcp_east"),
      stubPreset("moq_mediamtx_gcp_east_srt"),
      stubPreset("moq_gcp_east_relay_d18"),
      stubPreset("moq_zixi_linode"),
      stubPreset("moq_mediamtx_linode_srt"),
      stubPreset("moq_linode_relay_d18"),
      stubPreset("moq_zixi_gcp_west", false),
      stubPreset("moq_gcp_west_relay_d18", false),
      stubPreset("moq_zixi_aws_east", false),
    ];
    const moq = ingestEndpointsForProtocol("moq", presets);
    const labels = moq.filter((item) => item.id !== "custom").map((item) => item.label);
    assert.deepEqual(
      labels,
      ENCODE_HOSTS.map((host) => `OpenMOQ · ${host.label}`),
    );
    assert.equal(
      moq.some((item) => item.id.includes("moq_relay") && !item.id.endsWith("_d18")),
      false,
    );
    const west = moq.find((item) => item.id === "gcp_west_moq_relay_d18");
    assert.equal(west?.available, false);
    assert.match(west?.detail ?? "", /Not deployed/);
    const central = moq.find((item) => item.id === "gcp_moq_relay_d18");
    assert.equal(central?.available, true);
    assert.match(central?.detail ?? "", /:14433/);
    const srt = ingestEndpointsFromPresets(presets).filter((item) => item.id.endsWith("_zixi"));
    assert.equal(srt.length, 9);
    assert.equal(srt.filter((item) => item.available).length, 3);
  });
});
