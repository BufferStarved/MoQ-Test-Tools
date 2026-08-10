import type { ReactNode } from "react";
import { metricDefinition } from "./metricDefinitions";

interface MetricLabelProps {
  metricKey: string;
  label?: string;
  className?: string;
}

/** Hover/focus tip matching the metrics "i" affordance — reusable for section headings. */
export function InfoTip({
  tip,
  children,
  className = "",
}: {
  tip: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`metric-label-wrap ${className}`.trim()}>
      {children}
      <span className="metric-info" aria-hidden="true">
        i
      </span>
      <span className="metric-tooltip" role="tooltip">
        {tip}
      </span>
    </span>
  );
}

export function MetricLabel({ metricKey, label, className = "" }: MetricLabelProps) {
  const definition = metricDefinition(metricKey);
  const text = label ?? definition?.label ?? metricKey;

  if (!definition?.description) {
    return <span className={className}>{text}</span>;
  }

  return (
    <InfoTip tip={definition.description} className={className}>
      <span className="metric-label-text">{text}</span>
    </InfoTip>
  );
}

interface SummaryMetricProps {
  metricKey: string;
  label?: string;
  value: string;
}

export function SummaryMetric({ metricKey, label, value }: SummaryMetricProps) {
  return (
    <div className="metric">
      <MetricLabel metricKey={metricKey} label={label} />
      <strong>{value}</strong>
    </div>
  );
}
