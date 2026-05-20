import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { createProjectFromIntent, parseTopologyIntent } from "../domain/topology-factory";
import type { ArtifactBundle } from "../export/artifact-bundle";
import { createArtifactBundle } from "../export/artifact-bundle";

export type AgentEventKind = "thought" | "skill-start" | "skill-result" | "artifact";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  skillName?: string;
  title: string;
  content: string;
}

export interface FakeAgentResult {
  events: AgentEvent[];
  project: CanonicalTsnProjectV0;
  bundle: ArtifactBundle;
}

export function runFakeTsnAgent(userIntent: string): FakeAgentResult {
  const intent = parseTopologyIntent(userIntent);
  const project = createProjectFromIntent(userIntent);
  const bundle = createArtifactBundle(project);

  return {
    project,
    bundle,
    events: [
      {
        id: "event-intent",
        kind: "thought",
        title: "需求识别",
        content: `识别到 ${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`,
      },
      {
        id: "event-topology-start",
        kind: "skill-start",
        skillName: "tsn-topology",
        title: "调用 tsn-topology",
        content: "生成线型交换机骨干和端系统接入拓扑。",
      },
      {
        id: "event-topology-result",
        kind: "skill-result",
        skillName: "tsn-topology",
        title: "拓扑结果",
        content: `已生成 ${project.topology.nodes.length} 个节点和 ${project.topology.links.length} 条链路。`,
      },
      {
        id: "event-flow-template",
        kind: "skill-result",
        skillName: "tsn-flow-template",
        title: "控制流模板",
        content: "先生成 1 条 ST 控制流，默认 PCP=6、周期=250us、帧长=512B，用于验证规划链路。",
      },
      {
        id: "event-export",
        kind: "artifact",
        skillName: "tsn-export",
        title: "导出文件",
        content: bundle.artifacts.map((artifact) => artifact.path).join("、"),
      },
    ],
  };
}
