export type StatusTone = "ok" | "warn" | "bad" | "idle" | "info";

interface StatusDotProps {
  tone: StatusTone;
  label?: string;
  pulse?: boolean;
  className?: string;
}

/**
 * Shared health-indicator dot. One visual language for "is this thing okay"
 * across the API connection banner, per-output job status, agent connection,
 * and player diagnostics — instead of every panel inventing its own pill.
 */
export function StatusDot({ tone, label, pulse = false, className = "" }: StatusDotProps) {
  return (
    <span className={`status-dot-wrap ${className}`.trim()}>
      <span className={`status-dot tone-${tone}${pulse ? " pulse" : ""}`} aria-hidden="true" />
      {label && <span className="status-dot-label">{label}</span>}
    </span>
  );
}
