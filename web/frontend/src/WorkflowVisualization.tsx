import { ArchStage, FlowArrow, FlowNode } from "./FlowDiagram";
import { IconCamera, IconCloud, IconCpu, IconFilm, IconLaptop } from "./Icons";
import type { PipelineDiagramSpec } from "./pipelineConfig";
import { protocolLabel } from "./protocolTheme";

/**
 * Recipe-driven end-to-end map, using the same stage/arrow language as About.
 * Source and encode are shared; ingest and playback stack one card per output.
 */
export function WorkflowVisualization({
  sourceTitle,
  sourceDetail,
  encodeTitle,
  encodeDetail,
  streams,
}: PipelineDiagramSpec) {
  const sourceIcon = /webcam|camera|browser/i.test(`${sourceTitle} ${sourceDetail}`) ? (
    <IconCamera size={15} />
  ) : (
    <IconFilm size={15} />
  );
  const encodeIcon = /browser/i.test(encodeTitle) ? (
    <IconCpu size={15} />
  ) : /computer|laptop|machine|agent/i.test(encodeTitle) ? (
    <IconLaptop size={15} />
  ) : (
    <IconCloud size={15} />
  );

  return (
    <div className="flow-diagram flow-diagram-compact e2e-diagram" aria-label="End-to-end pipeline">
      <ArchStage step="1" label="Source" tone="client">
        <FlowNode tone="client" title={sourceTitle} detail={sourceDetail} icon={sourceIcon} />
      </ArchStage>
      <FlowArrow />
      <ArchStage step="2" label="Encode" tone="server">
        <FlowNode tone="server" title={encodeTitle} detail={encodeDetail} icon={encodeIcon} />
      </ArchStage>
      <FlowArrow />
      <ArchStage step="3" label="Ingest" tone="transport">
        {streams.map((stream) => (
          <FlowNode
            key={`${stream.id}-ingest`}
            tone="transport"
            title={stream.ingest}
            detail={`${stream.label} · ${protocolLabel(stream.protocol)}`}
            accentColor={stream.accentColor}
          />
        ))}
      </ArchStage>
      <FlowArrow />
      <ArchStage step="4" label="Playback" tone="client">
        {streams.map((stream) => (
          <FlowNode
            key={`${stream.id}-play`}
            tone="client"
            title={stream.player}
            detail={stream.packager}
            accentColor={stream.accentColor}
          />
        ))}
      </ArchStage>
    </div>
  );
}
