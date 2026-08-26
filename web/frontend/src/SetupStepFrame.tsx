import type { ReactNode } from "react";
import type { SetupStepId, SetupStepState } from "./setupWizard";

interface SetupStepFrameProps {
  step: SetupStepId;
  index: number;
  state: SetupStepState;
  title: string;
  summary: string;
  onReopen: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  children: ReactNode;
}

/** Current step is the full form. Earlier steps collapse so operators can go back. */
export function SetupStepFrame({
  step,
  index,
  state,
  title,
  summary,
  onReopen,
  onContinue,
  continueLabel = "Continue",
  children,
}: SetupStepFrameProps) {
  if (state === "hidden") {
    return null;
  }
  if (state === "collapsed") {
    return (
      <button
        type="button"
        className="setup-step-summary"
        data-setup-step={step}
        data-setup-state="collapsed"
        onClick={onReopen}
      >
        <span className="setup-step-summary-index" aria-hidden="true">
          {index}
        </span>
        <span className="setup-step-summary-copy">
          <span className="setup-step-summary-title">{title}</span>
          <span className="setup-step-summary-value">{summary}</span>
        </span>
        <span className="setup-step-summary-action">Change</span>
      </button>
    );
  }
  return (
    <div className="setup-step-current" data-setup-step={step} data-setup-state="current">
      {children}
      {onContinue ? (
        <div className="setup-step-continue">
          <button type="button" className="primary" onClick={onContinue}>
            {continueLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
