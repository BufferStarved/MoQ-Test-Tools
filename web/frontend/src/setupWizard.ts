/**
 * Sequential setup: operators see one decision at a time.
 * Recipe locks still hide steps the preset already decided; this module
 * then reveals the remaining steps only after the current one is done.
 */
import {
  recipeShowsEndpointPickers,
  recipeShowsSharedProtocolPicker,
  wizardStepVisible,
  type BenchmarkPresetId,
} from "./benchmarkPresets.ts";

export const SETUP_STEP_IDS = [
  "recipe",
  "testScope",
  "source",
  "protocol",
  "encode",
  "outputs",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupStepState = "hidden" | "collapsed" | "current";

export interface SetupStepFlags {
  testScope: boolean;
  source: boolean;
  protocol: boolean;
  encode: boolean;
  outputs: boolean;
}

/** Which wizard panes this recipe still asks the operator to decide. */
export function setupFlagsForPreset(id: BenchmarkPresetId | null): SetupStepFlags {
  return {
    testScope: wizardStepVisible(id, "testScope"),
    source: wizardStepVisible(id, "source"),
    protocol: recipeShowsSharedProtocolPicker(id),
    encode: id !== null,
    outputs: wizardStepVisible(id, "outputs") || recipeShowsEndpointPickers(id),
  };
}

export function setupStepsForRecipe(flags: SetupStepFlags): SetupStepId[] {
  const steps: SetupStepId[] = ["recipe"];
  if (flags.testScope) {
    steps.push("testScope");
  }
  if (flags.source) {
    steps.push("source");
  }
  if (flags.protocol) {
    steps.push("protocol");
  }
  if (flags.encode) {
    steps.push("encode");
  }
  if (flags.outputs) {
    steps.push("outputs");
  }
  return steps;
}

export function firstStepAfterRecipe(steps: readonly SetupStepId[]): SetupStepId {
  return steps[1] ?? "recipe";
}

export function nextSetupStep(
  steps: readonly SetupStepId[],
  cursor: SetupStepId,
): SetupStepId | null {
  const index = steps.indexOf(cursor);
  if (index < 0 || index >= steps.length - 1) {
    return null;
  }
  return steps[index + 1] ?? null;
}

export function isLastSetupStep(steps: readonly SetupStepId[], cursor: SetupStepId): boolean {
  return steps.length > 0 && steps[steps.length - 1] === cursor;
}

export function clampSetupCursor(
  steps: readonly SetupStepId[],
  cursor: SetupStepId,
): SetupStepId {
  if (steps.includes(cursor)) {
    return cursor;
  }
  return steps[0] ?? "recipe";
}

/**
 * During a run, every left-pane step collapses so players/charts stay the
 * focus. Outputs live in the run column, so they are not expanded here.
 */
export function setupStepState(
  steps: readonly SetupStepId[],
  cursor: SetupStepId,
  step: SetupStepId,
  runLayout = false,
): SetupStepState {
  const stepIndex = steps.indexOf(step);
  if (stepIndex < 0) {
    return "hidden";
  }
  if (runLayout) {
    return step === "outputs" ? "hidden" : "collapsed";
  }
  const cursorIndex = steps.indexOf(cursor);
  const safeCursor = cursorIndex < 0 ? 0 : cursorIndex;
  if (stepIndex > safeCursor) {
    return "hidden";
  }
  if (stepIndex < safeCursor) {
    return "collapsed";
  }
  return "current";
}
