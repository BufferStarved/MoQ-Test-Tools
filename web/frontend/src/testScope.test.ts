import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TEST_SCOPE,
  canOverlayTestScopes,
  isUploadOnlyScope,
  parseTestScope,
  testScopeBanner,
  testScopesCompatible,
} from "./testScope.ts";

describe("testScope", () => {
  it("defaults to end-to-end glass", () => {
    assert.equal(DEFAULT_TEST_SCOPE, "e2e");
    assert.equal(parseTestScope("upload"), "upload");
    assert.equal(parseTestScope("nope"), "e2e");
    assert.equal(isUploadOnlyScope("upload"), true);
  });

  it("watermarks upload results as ingest, not glass", () => {
    assert.match(testScopeBanner("upload"), /not glass/i);
    assert.match(testScopeBanner("e2e"), /glass/i);
  });

  it("refuses to overlay different test_scope values", () => {
    assert.equal(testScopesCompatible("e2e", "upload"), false);
    assert.equal(canOverlayTestScopes(["e2e", "e2e"]), true);
    assert.equal(canOverlayTestScopes(["e2e", "upload"]), false);
    assert.equal(canOverlayTestScopes(["upload", "upload"]), true);
    assert.equal(canOverlayTestScopes(["e2e", "e2e", "upload"]), false);
  });

  it("keeps contribution recipes on upload so they cannot silently mean glass", () => {
    assert.equal(parseTestScope("upload"), "upload");
    assert.match(testScopeBanner("upload"), /not glass/i);
  });
});
