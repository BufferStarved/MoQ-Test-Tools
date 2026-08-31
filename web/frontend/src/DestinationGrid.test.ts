import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  gridIngestRoles,
  optionForHostCell,
  pickDestForHost,
  pickDestForRole,
  preferredOptionForHost,
  softwareLabel,
  unavailableDestLabel,
} from "./destinationGridModel.ts";
import { PROD_PRESETS } from "./fixtures/prodPresets.ts";
import { ingestCollisionKey, type IngestEndpointOption } from "./ingestEndpoints.ts";
import { RECIPE_CHROME_CAPS, destinationsForProtocol, type RecipeContext } from "./recipeSupport.ts";

const options: IngestEndpointOption[] = [
  { id: "gcp_east_mediamtx", label: "MediaMTX · GCP East", detail: "", available: true },
  { id: "gcp_east_zixi", label: "Zixi · GCP East", detail: "", available: true },
  { id: "linode_central_mediamtx", label: "MediaMTX · Linode Central", detail: "", available: true },
  { id: "linode_central_zixi", label: "Zixi · Linode Central", detail: "", available: false },
  { id: "aws_east_mediamtx", label: "MediaMTX · AWS East", detail: "", available: false },
  { id: "custom", label: "Custom URL", detail: "", available: true },
];

const recipeCtx: RecipeContext = {
  source: "webcam",
  encoder: "ffmpeg",
  presets: PROD_PRESETS,
  caps: RECIPE_CHROME_CAPS,
};

describe("destination grid", () => {
  it("picks the first ranked option on a host and labels software", () => {
    const east = preferredOptionForHost("gcp_east", options);
    assert.equal(east?.id, "gcp_east_mediamtx");
    assert.equal(softwareLabel("gcp_east_mediamtx"), "MediaMTX");
    assert.equal(softwareLabel("linode_west_moq_relay_d18"), "MoQ");
    assert.equal(softwareLabel("gcp_zixi"), "Zixi");
  });

  it("keeps Dallas MediaMTX live while Dallas Zixi stays undeployed", () => {
    const dallas = preferredOptionForHost("linode_central", options);
    assert.equal(dallas?.id, "linode_central_mediamtx");
    assert.equal(dallas?.available, true);
    const zixi = options.find((item) => item.id === "linode_central_zixi");
    assert.equal(zixi?.available, false);
  });

  it("does not treat Custom as a host cell", () => {
    assert.equal(preferredOptionForHost("gcp_central", options), undefined);
  });

  it("names down dests vs undeployed cells vs in-use", () => {
    assert.equal(unavailableDestLabel("Zixi dest is down"), "This box is down");
    assert.equal(unavailableDestLabel("guest frozen", "Zixi"), "Zixi (this box is down)");
    assert.equal(unavailableDestLabel("Not deployed · us-west1", "MoQ"), "MoQ — not deployed");
    assert.equal(unavailableDestLabel("In use by another output", "Zixi"), "Zixi (in use)");
  });
});

describe("SRT Zixi dest grid vs MediaMTX preferred sort", () => {
  const dests = destinationsForProtocol("srt", recipeCtx, new Set(), { includeOccupied: true });
  const free = () => false;

  it("shows East + Linode East Zixi SRT when ingest is Zixi", () => {
    assert.equal(optionForHostCell("gcp_east", dests, "zixi", free)?.id, "gcp_east_zixi");
    assert.equal(optionForHostCell("gcp_east", dests, "zixi", free)?.available, true);
    assert.equal(optionForHostCell("linode_east", dests, "zixi", free)?.id, "linode_zixi");
    assert.equal(optionForHostCell("linode_east", dests, "zixi", free)?.available, true);
    assert.equal(optionForHostCell("gcp_central", dests, "zixi", free)?.id, "gcp_zixi");
    assert.equal(softwareLabel(optionForHostCell("gcp_east", dests, "zixi", free)?.id ?? ""), "Zixi");
    assert.equal(softwareLabel(optionForHostCell("linode_east", dests, "zixi", free)?.id ?? ""), "Zixi");
  });

  it("keeps Dallas/Fremont MediaMTX and greys undeployed West/AWS Zixi", () => {
    assert.equal(
      optionForHostCell("linode_central", dests, "zixi", free)?.id,
      "linode_central_mediamtx",
    );
    assert.equal(optionForHostCell("linode_west", dests, "zixi", free)?.id, "linode_west_mediamtx");
    assert.equal(optionForHostCell("gcp_west", dests, "zixi", free)?.available, false);
    assert.equal(optionForHostCell("aws_east", dests, "zixi", free)?.available, false);
  });

  it("does not hide Central Zixi as Not deployed when a sibling already took it", () => {
    const occupied = new Set([ingestCollisionKey("gcp_zixi", "srt")]);
    const hidden = destinationsForProtocol("srt", recipeCtx, occupied);
    assert.equal(
      hidden.some((item) => item.id === "gcp_zixi"),
      false,
      "coerce/add still excludes the taken slot",
    );
    const shown = destinationsForProtocol("srt", recipeCtx, occupied, { includeOccupied: true });
    assert.equal(shown.some((item) => item.id === "gcp_zixi"), true);
    const taken = (id: string) => occupied.has(ingestCollisionKey(id, "srt") ?? "");
    const central = optionForHostCell("gcp_central", shown, "zixi", taken);
    assert.equal(central?.id, "gcp_zixi");
    assert.equal(taken(central?.id ?? ""), true);
    assert.equal(optionForHostCell("gcp_east", shown, "zixi", taken)?.id, "gcp_east_zixi");
    assert.equal(optionForHostCell("linode_east", shown, "zixi", taken)?.id, "linode_zixi");
  });

  it("clicking East while Zixi is selected picks East Zixi, not MediaMTX", () => {
    assert.equal(pickDestForHost("gcp_east", dests, "gcp_zixi", free), "gcp_east_zixi");
    assert.equal(pickDestForHost("linode_east", dests, "gcp_east_zixi", free), "linode_zixi");
    assert.equal(pickDestForRole("zixi", dests, free, "gcp_east"), "gcp_east_zixi");
    assert.deepEqual(gridIngestRoles(dests).sort(), ["mediamtx", "zixi"].sort());
  });

  it("labels East MediaMTX when ingest is MediaMTX", () => {
    assert.equal(optionForHostCell("gcp_east", dests, "mediamtx", free)?.id, "gcp_east_mediamtx");
    assert.equal(pickDestForHost("gcp_east", dests, "gcp_mediamtx", free), "gcp_east_mediamtx");
  });
});
