import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSetupCursor,
  firstStepAfterRecipe,
  isLastSetupStep,
  nextSetupStep,
  setupFlagsForPreset,
  setupStepState,
  setupStepsForRecipe,
} from "./setupWizard.ts";

describe("setup wizard sequence", () => {
  it("starts with only Recipe until a preset is picked", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset(null));
    assert.deepEqual(steps, ["recipe"]);
    assert.equal(setupStepState(steps, "recipe", "recipe"), "current");
    assert.equal(setupStepState(steps, "recipe", "source"), "hidden");
    assert.equal(setupStepState(steps, "recipe", "outputs"), "hidden");
  });

  it("Custom walks Test → Source → Encode → Outputs one at a time", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset("build-your-own"));
    assert.deepEqual(steps, ["recipe", "testScope", "source", "encode", "outputs"]);
    assert.equal(firstStepAfterRecipe(steps), "testScope");
    assert.equal(setupStepState(steps, "testScope", "recipe"), "collapsed");
    assert.equal(setupStepState(steps, "testScope", "testScope"), "current");
    assert.equal(setupStepState(steps, "testScope", "source"), "hidden");
    assert.equal(setupStepState(steps, "testScope", "encode"), "hidden");
    assert.equal(setupStepState(steps, "testScope", "outputs"), "hidden");
    assert.equal(nextSetupStep(steps, "testScope"), "source");
    assert.equal(nextSetupStep(steps, "outputs"), null);
    assert.equal(isLastSetupStep(steps, "encode"), false);
    assert.equal(isLastSetupStep(steps, "outputs"), true);
  });

  it("Capture to glass skips Test and Outputs; Source then Encode", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset("protocol-compare"));
    assert.deepEqual(steps, ["recipe", "source", "encode"]);
    assert.equal(firstStepAfterRecipe(steps), "source");
    assert.equal(setupStepState(steps, "source", "outputs"), "hidden");
    assert.equal(setupStepState(steps, "encode", "source"), "collapsed");
    assert.equal(isLastSetupStep(steps, "encode"), true);
  });

  it("Where to host inserts the shared protocol picker before Encode and hides dests", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset("cloud-compare"));
    assert.deepEqual(steps, ["recipe", "source", "protocol", "encode"]);
    assert.equal(setupStepState(steps, "protocol", "source"), "collapsed");
    assert.equal(setupStepState(steps, "protocol", "encode"), "hidden");
    assert.equal(setupStepState(steps, "encode", "outputs"), "hidden");
  });

  it("Ingest only keeps Source and Encode, hides dest/player matrix", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset("contribution-compare"));
    assert.deepEqual(steps, ["recipe", "source", "encode"]);
  });

  it("MoQ vs WebRTC only asks Encode after the recipe", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset("webrtc-vs-moq"));
    assert.deepEqual(steps, ["recipe", "encode"]);
    assert.equal(firstStepAfterRecipe(steps), "encode");
  });

  it("collapses left-pane steps during a run and leaves Outputs to the run column", () => {
    const steps = setupStepsForRecipe(setupFlagsForPreset("build-your-own"));
    assert.equal(setupStepState(steps, "outputs", "recipe", true), "collapsed");
    assert.equal(setupStepState(steps, "outputs", "encode", true), "collapsed");
    assert.equal(setupStepState(steps, "outputs", "outputs", true), "hidden");
  });

  it("clamps a stale cursor when the recipe drops that step", () => {
    assert.equal(clampSetupCursor(["recipe", "encode"], "testScope"), "recipe");
    assert.equal(clampSetupCursor(["recipe", "source", "encode"], "source"), "source");
  });
});
