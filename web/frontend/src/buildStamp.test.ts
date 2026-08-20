import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBuildStamp } from "./buildStamp.ts";

describe("formatBuildStamp", () => {
  it("uses the baked SHA", () => {
    assert.equal(formatBuildStamp("a4ecf5e"), "a4ecf5e");
  });

  it("falls back to dev when the env is empty", () => {
    assert.equal(formatBuildStamp(undefined), "dev");
    assert.equal(formatBuildStamp("  "), "dev");
  });
});
