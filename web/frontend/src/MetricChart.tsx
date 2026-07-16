import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartPoint, ChartSeries } from "./chartData";
import { MetricLabel } from "./MetricLabel";

interface MetricChartProps {
  title: string;
  metricKey?: string;
  data: ChartPoint[];
  series: ChartSeries[];
  height?: number;
  yDomain?: [number, number];
}

function formatValue(value: number, unit?: string): string {
  if (unit === "kbps") {
    return `${value.toFixed(0)} kbps`;
  }
  if (unit === "fps") {
    return `${value.toFixed(1)} fps`;
  }
  if (unit === "ms") {
    return `${value.toFixed(2)} ms`;
  }
  if (unit === "%") {
    return `${value.toFixed(1)}%`;
  }
  if (unit === "MB") {
    return `${value.toFixed(1)} MB`;
  }
  if (unit === "x") {
    return `${value.toFixed(2)}x`;
  }
  if (unit === "cv") {
    return value.toFixed(4);
  }
  if (unit === "score") {
    return value.toFixed(1);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: number;
  series: ChartSeries[];
}) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">t = {label}s</div>
      {payload.map((entry) => {
        const meta = series.find((item) => item.key === entry.dataKey);
        return (
          <div key={entry.dataKey} className="chart-tooltip-row">
            <span className="chart-tooltip-dot" style={{ background: entry.color }} />
            <span>{meta?.label ?? entry.dataKey}</span>
            <strong>{formatValue(entry.value, meta?.unit)}</strong>
          </div>
        );
      })}
    </div>
  );
}

export function MetricChart({
  title,
  metricKey,
  data,
  series,
  height = 220,
  yDomain,
}: MetricChartProps) {
  const activeSeries = series.filter((item) => data.some((point) => point[item.key] > 0));

  if (activeSeries.length === 0) {
    return null;
  }

  return (
    <div className="chart-card">
      <div className="chart-card-header">
        {metricKey ? (
          <MetricLabel metricKey={metricKey} label={title} className="chart-title" />
        ) : (
          <h4>{title}</h4>
        )}
      </div>
      <div className="chart-container" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
            <XAxis
              dataKey="second"
              tick={{ fill: "#94a3b8", fontSize: 12 }}
              axisLine={{ stroke: "rgba(148, 163, 184, 0.2)" }}
              tickLine={false}
              label={{ value: "Seconds", position: "insideBottom", offset: -2, fill: "#64748b" }}
            />
            <YAxis
              tick={{ fill: "#94a3b8", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={48}
              domain={yDomain}
            />
            <Tooltip content={<ChartTooltip series={activeSeries} />} />
            {activeSeries.length > 1 && <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />}
            {activeSeries.map((item) => (
              <Line
                key={item.key}
                type="monotone"
                dataKey={item.key}
                name={item.label}
                stroke={item.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
