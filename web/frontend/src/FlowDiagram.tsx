import type { ReactNode } from "react";

/**
 * Shared "pipeline" diagram primitives — small labeled boxes joined by
 * arrows. Originally built for the About page's static architecture
 * diagram; reused by WorkflowVisualization for a live version driven by the
 * user's actual recipe selections, so both stay visually consistent.
 */

export type FlowTone = "default" | "client" | "transport" | "server" | "quality";

export function FlowArrow() {
  return (
    <span className="flow-diagram-arrow" aria-hidden="true">
      →
    </span>
  );
}

export function FlowNode({
  title,
  detail,
  tone = "default",
  icon,
}: {
  title: string;
  detail?: string;
  tone?: FlowTone;
  icon?: ReactNode;
}) {
  return (
    <div className={`flow-diagram-node tone-${tone}`}>
      <span className="flow-diagram-node-title">
        {icon && <span className="icon-inline">{icon}</span>}
        <strong>{title}</strong>
      </span>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function ArchStage({
  step,
  label,
  tone,
  children,
}: {
  step: string;
  label: string;
  tone: "client" | "server" | "transport" | "quality";
  children: ReactNode;
}) {
  return (
    <div className={`flow-diagram-stage tone-${tone}`}>
      <div className="flow-diagram-stage-label">
        <span className="flow-diagram-step">{step}</span>
        {label}
      </div>
      <div className="flow-diagram-stage-body">{children}</div>
    </div>
  );
}
