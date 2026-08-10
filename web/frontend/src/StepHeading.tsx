import { InfoTip } from "./MetricLabel";

interface StepHeadingProps {
  step: number;
  title: string;
  tip: string;
}

/** Numbered step title with the same hover tip pattern as metric labels. */
export function StepHeading({ step, title, tip }: StepHeadingProps) {
  return (
    <div className="step-heading">
      <InfoTip tip={tip} className="step-heading-tip">
        <span className="step-badge">{step}</span>
        <h3 className="metric-label-text">{title}</h3>
      </InfoTip>
    </div>
  );
}
