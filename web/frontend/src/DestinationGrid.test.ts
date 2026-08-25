import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredOptionForHost, softwareLabel } from "./destinationGridModel.ts";
import type { IngestEndpointOption } from "./ingestEndpoints.ts";

const options: IngestEndpointOption[] = [
  { id: "gcp_east_mediamtx", label: "MediaMTX · GCP East", detail: "", available: true },
  { id: "gcp_east_zixi", label: "Zixi · GCP East", detail: "", available: true },
  { id: "linode_central_mediamtx", label: "MediaMTX · Linode Central", detail: "", available: true },
  { id: "linode_central_zixi", label: "Zixi · Linode Central", detail: "", available: false },
  { id: "aws_east_mediamtx", label: "MediaMTX · AWS East", detail: "", available: false },
  { id: "custom", label: "Custom URL", detail: "", available: true },
];

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
});
