import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminBaseUrlForEndpoint, adminPortForEndpoint } from "./moqAdmin.ts";

describe("moq admin URL", () => {
  it("maps leftover :4433 to :8000 and canary :14433 to :18000", () => {
    assert.equal(
      adminPortForEndpoint("https://34-28-164-90.sslip.io:4433/moq-relay"),
      8000,
    );
    assert.equal(
      adminPortForEndpoint(
        "https://45-79-177-85.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
      ),
      18000,
    );
    assert.equal(
      adminBaseUrlForEndpoint("https://45-79-177-85.sslip.io:14433/moq-relay"),
      "http://45.79.177.85:18000",
    );
    assert.equal(
      adminBaseUrlForEndpoint("https://34-28-164-90.sslip.io:4433/moq-relay"),
      "http://34.28.164.90:8000",
    );
  });
});
