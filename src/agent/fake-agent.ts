import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { getScenarioConfig } from "../domain/scenario-config";
import { createProjectFromIntent, parseTopologyIntent } from "../domain/topology-factory";
import type { ArtifactBundle } from "../export/artifact-bundle";
import { createArtifactBundle } from "../export/artifact-bundle";
import {
  confirmCurrentStage,
  normalizeWorkflowState,
  recordStageResult,
  requestStageChanges,
  type WorkflowState,
  type WorkflowStep,
} from "../project/project-state";

export type AgentEventKind =
  | "thought"
  | "skill-start"
  | "skill-result"
  | "artifact"
  | "stage-start"
  | "stage-result"
  | "confirmation-required"
  | "tool-availability"
  | "error";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  stage?: WorkflowStep;
  skillName?: string;
  title: string;
  content: string;
  status?: "info" | "success" | "warning" | "error";
  createdAt?: string;
}

export interface FakeAgentResult {
  events: AgentEvent[];
  project: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
  workflow: WorkflowState;
  assistantText: string;
}

export function runFakeTsnAgent(
  userIntent: string,
  previousProject?: CanonicalTsnProjectV0,
  previousWorkflow?: WorkflowState,
): FakeAgentResult {
  const baseWorkflow = normalizeWorkflowState(previousWorkflow);
  const fallbackIntent = previousProject ? inferIntentFromProject(previousProject) : undefined;

  if (isQuickGenerateIntent(userIntent)) {
    return runQuickGenerate(userIntent, previousProject, baseWorkflow);
  }

  if (hasTopologyChangeIntent(userIntent, baseWorkflow)) {
    return runTopologyStage(userIntent, previousProject, requestStageChanges(baseWorkflow, "topology"));
  }

  if (isContinuationIntent(userIntent) && baseWorkflow.stages[baseWorkflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(userIntent, previousProject, baseWorkflow);
  }

  if (baseWorkflow.currentStep === "topology") {
    return runTopologyStage(userIntent, previousProject, baseWorkflow);
  }

  return runCurrentStage(previousProject, baseWorkflow);
}

export function hasExplicitTopologyIntent(text: string): boolean {
  return /(\d+)\s*(?:个|台)?\s*(?:交换机|switch)/i.test(text)
    || /(?:每个|each).*?(\d+)\s*(?:个|台)?\s*(?:端系统|终端|端|host|end)/i.test(text);
}

function runAfterConfirmation(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const confirmed = confirmCurrentStage(workflow);

  if (confirmed.currentStep === workflow.currentStep) {
    return completeFinalStage(userIntent, previousProject, workflow, confirmed);
  }

  return runCurrentStage(previousProject, confirmed, userIntent);
}

function completeFinalStage(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  previousWorkflow: WorkflowState,
  confirmedWorkflow: WorkflowState,
): FakeAgentResult {
  const project = previousProject
    ? refreshProject(previousProject)
    : createProjectFromIntent(userIntent || "请生成默认拓扑", undefined, {
        scenarioConfigId: confirmedWorkflow.scenarioConfigId,
      });
  const bundle = createArtifactBundle(project);
  const summary = previousWorkflow.stages[previousWorkflow.currentStep].summary ?? "当前阶段已确认完成。";
  const events = [
    createToolAvailabilityEvent(),
    createStageResultEvent(previousWorkflow.currentStep, "阶段已确认", summary),
  ] satisfies AgentEvent[];

  return {
    project,
    bundle,
    workflow: confirmedWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runCurrentStage(
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
  userIntent = "",
): FakeAgentResult {
  if (workflow.currentStep === "topology" || !previousProject) {
    return runTopologyStage(userIntent || "请生成默认拓扑", previousProject, workflow);
  }

  if (workflow.currentStep === "time-sync") {
    return runTimeSyncStage(previousProject, workflow);
  }

  if (workflow.currentStep === "flow-template") {
    return runFlowStage(previousProject, workflow);
  }

  return runPlanningExportStage(previousProject, workflow);
}

function runTopologyStage(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const fallbackIntent = previousProject ? inferIntentFromProject(previousProject) : undefined;
  const project = createProjectFromIntent(userIntent, fallbackIntent, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
  const intent = parseTopologyIntent(userIntent, fallbackIntent, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
  const summary = `识别到 ${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
  const nextWorkflow = recordStageResult(workflow, {
    step: "topology",
    summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("topology", "拓扑阶段开始", "解析自然语言拓扑规模，准备生成 canonical 拓扑。"),
    {
      id: "event-intent",
      kind: "thought",
      stage: "topology",
      title: "需求识别",
      content: summary,
      status: "info",
    },
    {
      id: "event-topology-result",
      kind: "skill-result",
      stage: "topology",
      skillName: "tsn-topology",
      title: "拓扑结果",
      content: `已生成 ${project.topology.nodes.length} 个节点和 ${project.topology.links.length} 条链路。`,
      status: "success",
    },
    createStageResultEvent("topology", "拓扑摘要", summary),
    createConfirmationEvent("topology", "确认拓扑后进入时间同步阶段，或继续描述需要修改的拓扑规模。"),
  ] satisfies AgentEvent[];

  return {
    project,
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runTimeSyncStage(project: CanonicalTsnProjectV0, workflow: WorkflowState): FakeAgentResult {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const summary = scenarioConfig.defaults.timeSyncSummary;
  const nextWorkflow = recordStageResult(workflow, {
    step: "time-sync",
    summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("time-sync", "时间同步阶段开始", "生成时间同步默认摘要。"),
    createStageResultEvent("time-sync", "时间同步默认值", summary),
    createConfirmationEvent("time-sync", "确认同步假设后进入建立流阶段，或说明需要调整的同步约束。"),
  ] satisfies AgentEvent[];

  return {
    project: refreshProject(project),
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runFlowStage(project: CanonicalTsnProjectV0, workflow: WorkflowState): FakeAgentResult {
  const flow = project.flows[0];
  const summary = flow
    ? `已准备 ${flow.name}，路径 ${flow.routeNodeIds.join(" -> ")}，周期 ${flow.periodUs}us，PCP ${flow.pcp}。`
    : "当前拓扑还没有可用流模板。";
  const nextWorkflow = recordStageResult(workflow, {
    step: "flow-template",
    summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("flow-template", "建立流阶段开始", "根据当前拓扑生成一条入门控制流模板。"),
    {
      id: "event-flow-template",
      kind: "skill-result",
      stage: "flow-template",
      skillName: "tsn-flow-template",
      title: "控制流模板",
      content: summary,
      status: "success",
    },
    createConfirmationEvent("flow-template", "确认流模板后发送规划并生成导出清单。"),
  ] satisfies AgentEvent[];

  return {
    project: refreshProject(project),
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runPlanningExportStage(project: CanonicalTsnProjectV0, workflow: WorkflowState): FakeAgentResult {
  const bundle = createArtifactBundle(project);
  const summary = `已生成规划器输入和导出清单：${bundle.artifacts.map((artifact) => artifact.path).join("、")}。`;
  const nextWorkflow = recordStageResult(workflow, {
    step: "planning-export",
    summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("planning-export", "发送规划阶段开始", "刷新规划器输入和项目导出清单。"),
    {
      id: "event-export",
      kind: "artifact",
      stage: "planning-export",
      skillName: "tsn-export",
      title: "导出文件",
      content: summary,
      status: "success",
    },
    createStageResultEvent("planning-export", "规划器输入已准备", "flow_plan_1.json 是规划器输入，不是规划器执行结果。"),
    createConfirmationEvent("planning-export", "确认发送规划后完成本轮草案，或继续描述需要修改的规划输入。"),
  ] satisfies AgentEvent[];

  return {
    project: refreshProject(project),
    bundle,
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runQuickGenerate(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const fallbackIntent = previousProject ? inferIntentFromProject(previousProject) : undefined;
  const project = previousProject && !hasExplicitTopologyIntent(userIntent)
    ? refreshProject(previousProject)
    : createProjectFromIntent(userIntent, fallbackIntent, {
        scenarioConfigId: workflow.scenarioConfigId,
      });
  const bundle = createArtifactBundle(project);
  const intent = inferIntentFromProject(project);
  const topologySummary = `识别到 ${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
  let nextWorkflow = recordStageResult(workflow, { step: "topology", summary: topologySummary });
  nextWorkflow = confirmCurrentStage(nextWorkflow);
  nextWorkflow = recordStageResult(nextWorkflow, {
    step: "time-sync",
    summary: scenarioConfig.defaults.timeSyncSummary,
  });
  nextWorkflow = confirmCurrentStage(nextWorkflow);
  nextWorkflow = recordStageResult(nextWorkflow, {
    step: "flow-template",
    summary: `已准备 ${project.flows[0]?.name ?? "控制流模板"}。`,
  });
  nextWorkflow = confirmCurrentStage(nextWorkflow);
  nextWorkflow = recordStageResult(nextWorkflow, {
    step: "planning-export",
    summary: `已生成 ${bundle.artifacts.length} 个导出文件。`,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("topology", "快速生成开始", "按显式快速路径连续完成拓扑、同步、建立流和发送规划。"),
    createStageResultEvent("topology", "拓扑结果", topologySummary),
    createStageResultEvent("time-sync", "时间同步默认值", scenarioConfig.defaults.timeSyncSummary),
    createStageResultEvent("flow-template", "控制流模板", `已准备 ${project.flows[0]?.name ?? "控制流模板"}。`),
    {
      id: "event-export",
      kind: "artifact",
      stage: "planning-export",
      skillName: "tsn-export",
      title: "导出文件",
      content: bundle.artifacts.map((artifact) => artifact.path).join("、"),
      status: "success",
    },
  ] satisfies AgentEvent[];

  return {
    project,
    bundle,
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function isContinuationIntent(text: string): boolean {
  return /^(直接生成|生成|确认|可以|好的|开始|继续|按这个|就这样|执行|下一步)\s*[。.!！]?$/i.test(text.trim());
}

function isQuickGenerateIntent(text: string): boolean {
  return /^(直接生成|生成完整草案|一键生成|生成全部|直接导出)\s*[。.!！]?$/i.test(text.trim());
}

function hasTopologyChangeIntent(text: string, workflow: WorkflowState): boolean {
  if (workflow.currentStep === "topology") {
    return hasExplicitTopologyIntent(text);
  }

  return hasExplicitTopologyIntent(text) || /拓扑|交换机|端系统|终端|host|end/i.test(text) && /改|调整|重新|变成/.test(text);
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

function createToolAvailabilityEvent(): AgentEvent {
  return {
    id: "event-tool-availability",
    kind: "tool-availability",
    title: "工具状态",
    content: "本轮未启用 Bash/Edit/Write；使用本地确定性 TSN 生成器和安全摘要事件。",
    status: "info",
  };
}

function createStageStartEvent(stage: WorkflowStep, title: string, content: string): AgentEvent {
  return {
    id: `event-${stage}-start`,
    kind: "stage-start",
    stage,
    title,
    content,
    status: "info",
  };
}

function createStageResultEvent(stage: WorkflowStep, title: string, content: string): AgentEvent {
  return {
    id: `event-${stage}-stage-result`,
    kind: "stage-result",
    stage,
    title,
    content,
    status: "success",
  };
}

function createConfirmationEvent(stage: WorkflowStep, content: string): AgentEvent {
  return {
    id: `event-${stage}-confirmation`,
    kind: "confirmation-required",
    stage,
    title: "等待确认",
    content,
    status: "warning",
  };
}
