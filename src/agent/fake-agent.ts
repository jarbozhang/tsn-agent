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
  assistantText: string;
}

export function runFakeTsnAgent(userIntent: string, previousProject?: CanonicalTsnProjectV0): FakeAgentResult {
  const shouldReuseProject = previousProject && isContinuationIntent(userIntent) && !hasExplicitTopologyIntent(userIntent);
  const fallbackIntent = previousProject ? inferIntentFromProject(previousProject) : undefined;
  const project = shouldReuseProject ? refreshProject(previousProject) : createProjectFromIntent(userIntent, fallbackIntent);
  const intent = shouldReuseProject ? inferIntentFromProject(project) : parseTopologyIntent(userIntent, fallbackIntent);
  const bundle = createArtifactBundle(project);

  const events: AgentEvent[] = [
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
  ];

  return {
    project,
    bundle,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

export function hasExplicitTopologyIntent(text: string): boolean {
  return /(\d+)\s*(?:个|台)?\s*(?:交换机|switch)/i.test(text)
    || /(?:每个|each).*?(\d+)\s*(?:个|台)?\s*(?:端系统|终端|端|host|end)/i.test(text);
}

function isContinuationIntent(text: string): boolean {
  return /^(直接生成|生成|确认|可以|好的|开始|继续|按这个|就这样|执行|下一步)\s*[。.!！]?$/i.test(text.trim());
}

function inferIntentFromProject(project: CanonicalTsnProjectV0) {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;

  return {
    switchCount,
    endSystemsPerSwitch: switchCount > 0 ? Math.round(endSystemCount / switchCount) : 0,
  };
}

function refreshProject(project: CanonicalTsnProjectV0): CanonicalTsnProjectV0 {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
  };
}
