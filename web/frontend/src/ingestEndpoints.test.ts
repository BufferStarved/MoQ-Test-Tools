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
  normalizePublishUrl,
  publishCollisionKeys,
  zixiFastHlsAvailable,
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
    assert.equal(defaultIngestForProtocol("srt"), "gcp_mediamtx");
    assert.equal(defaultIngestForProtocol("srt", "gcp_east"), "gcp_east_mediamtx");
    assert.equal(defaultIngestForProtocol("srt", "gcp_central"), "gcp_mediamtx");
    assert.notEqual(defaultIngestForProtocol("srt"), "gcp_zixi");
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
    assert.equal(zixiFastHlsAvailable("gcp_zixi"), true);
    assert.equal(zixiFastHlsAvailable("gcp_east_zixi"), false);
    assert.equal(zixiFastHlsAvailable("linode_zixi"), false);
    const eastZixi = srt.find((item) => item.id === "gcp_east_zixi");
    const centralZixi = srt.find((item) => item.id === "gcp_zixi");
    assert.match(eastZixi?.detail ?? "", /HTTP-TS/);
    assert.doesNotMatch(eastZixi?.detail ?? "", /Broadcaster Fast HLS/);
    assert.match(centralZixi?.detail ?? "", /Fast HLS/);
  });

  it("surfaces dest-down notes instead of Not deployed for dead GCP Zixi", () => {
    const presets = [
      stubPreset("moq_zixi_gcp", false),
      stubPreset("moq_mediamtx_gcp_srt"),
      stubPreset("moq_gcp_relay_d18"),
    ];
    presets[0]!.notes = "Zixi Broadcaster at 35.222.33.58 is down (guest frozen).";
    const endpoints = ingestEndpointsFromPresets(presets);
    const zixi = endpoints.find((item) => item.id === "gcp_zixi");
    assert.equal(zixi?.available, false);
    assert.match(zixi?.detail ?? "", /35\.222\.33\.58/);
    assert.doesNotMatch(zixi?.detail ?? "", /Not deployed/);
  });
});

describe("publish collision slots", () => {
  it("collides a custom WHIP URL with the same path as a preset tile", () => {
    const whip = "http://66.175.213.81:8889/benchmark/whip";
    const preset = publishCollisionKeys(
      { protocol: "webrtc", ingestEndpointId: "linode_mediamtx" },
      whip,
    );
    const custom = publishCollisionKeys({
      protocol: "webrtc",
      ingestEndpointId: "custom",
      endpointUrl: whip,
    });
    assert.ok(preset.some((key) => custom.includes(key)));
    assert.equal(normalizePublishUrl(`${whip}?foo=1`), normalizePublishUrl(whip));
  });

  it("does not collide two MoQ legs on the same relay", () => {
    const keys = publishCollisionKeys(
      { protocol: "moq", ingestEndpointId: "gcp_east_moq_relay_d18" },
      "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
    );
    assert.equal(keys.some((key) => key.startsWith("url:")), false);
  });
});
