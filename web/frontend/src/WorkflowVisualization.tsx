import type { CSSProperties } from "react";
import { ArchStage, FlowArrow, FlowNode } from "./FlowDiagram";
import { IconBroadcast, IconCamera, IconCloud, IconFilm, IconLaptop, IconMonitor, IconTarget } from "./Icons";

export interface WorkflowStreamBranch {
  id: string;
  label: string;
  protocol: string;
  ingestLabel: string;
  playerLabel: string;
  accentColor: string;
}

interface WorkflowVisualizationProps {
  sourceTitle: string;
  sourceDetail: string;
  encodeTitle: string;
  encodeDetail: string;
  streams: WorkflowStreamBranch[];
}

/**
 * Live version of the About page's static architecture diagram — reflects
 * the run recipe currently selected (source, encode location, and each
 * stream's protocol/ingest/player) instead of a fixed example, so the
 * pipeline shape is visible before pressing Start.
 */
export function WorkflowVisualization({
  sourceTitle,
  sourceDetail,
  encodeTitle,
  encodeDetail,
  streams,
}: WorkflowVisualizationProps) {
  const sourceIcon = sourceTitle.toLowerCase().includes("webcam") ? <IconCamera size={14} /> : <IconFilm size={14} />;
  const encodeIcon = encodeTitle.toLowerCase().includes("machine") ? <IconLaptop size={14} /> : <IconCloud size={14} />;

  return (
    <div className="workflow-viz">
      <div className="flow-diagram flow-diagram-compact workflow-viz-trunk">
        <ArchStage step="1" label="Source" tone="client">
          <FlowNode tone="client" title={sourceTitle} detail={sourceDetail} icon={sourceIcon} />
        </ArchStage>
        <FlowArrow />
        <ArchStage step="2" label="Encode" tone="server">
          <FlowNode tone="server" title={encodeTitle} detail={encodeDetail} icon={encodeIcon} />
        </ArchStage>
      </div>
      <p className="workflow-viz-fanout-label">
        Fans out to {streams.length} output{streams.length === 1 ? "" : "s"} →
      </p>
      <div className="workflow-branches">
        {streams.map((stream) => (
          <div
            key={stream.id}
            className="workflow-branch"
            style={{ "--protocol-accent": stream.accentColor } as CSSProperties}
          >
            <span className="workflow-branch-label">{stream.label}</span>
            <span className="workflow-branch-chip">
              <IconBroadcast size={12} />
              {stream.protocol}
            </span>
            <span className="workflow-branch-arrow" aria-hidden="true">
              →
            </span>
            <span className="workflow-branch-chip">
              <IconTarget size={12} />
              {stream.ingestLabel}
            </span>
            <span className="workflow-branch-arrow" aria-hidden="true">
              →
            </span>
            <span className="workflow-branch-chip">
              <IconMonitor size={12} />
              {stream.playerLabel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
