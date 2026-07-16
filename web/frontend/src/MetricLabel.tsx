import { metricDefinition } from "./metricDefinitions";

interface MetricLabelProps {
  metricKey: string;
  label?: string;
  className?: string;
}

export function MetricLabel({ metricKey, label, className = "" }: MetricLabelProps) {
  const definition = metricDefinition(metricKey);
  const text = label ?? definition?.label ?? metricKey;

  if (!definition?.description) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={`metric-label-wrap ${className}`.trim()}>
      <span className="metric-label-text">{text}</span>
      <span className="metric-info" aria-hidden="true">
        i
      </span>
      <span className="metric-tooltip" role="tooltip">
        {definition.description}
      </span>
    </span>
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
