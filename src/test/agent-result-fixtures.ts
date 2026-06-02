import {
  type AgentEvent,
  type AgentFailurePreservedStateResult,
  type AgentRuntimeUnavailableResult,
  type AgentStepDetail,
  type AgentSuccessResult,
  type TsnAgentResult,
} from "../agent/agent-types";
import {
  createProjectFromIntent,
  inferIntentFromProject,
  withDefaultControlFlow,
  withFlowsFromIntent,
} from "../domain/topology-factory";
import { confirmCurrentStage, normalizeWorkflowState, recordStageResult } from "../project/project-state";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { createArtifactBundle } from "../export/artifact-bundle";
import type { ArtifactBundle } from "../export/artifact-bundle";

let fixtureCounter = 0;

function fixtureId(prefix: string): string {
  fixtureCounter += 1;
  return `${prefix}-${fixtureCounter}`;
}

export interface FixtureRunIds {
  runId: string;
  traceId: string;
}

export function createFixtureRunIds(): FixtureRunIds {
  return {
    runId: fixtureId("run"),
    traceId: fixtureId("trace"),
  };
}

interface FixtureStepInput {
  kind?: AgentEvent["kind"];
  title?: string;
  content?: string;
  status?: AgentEvent["status"];
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  errorSummary?: string;
  toolUseId?: string;
  sequence?: number;
}

export function createFixtureAgentEvent(
  ids: FixtureRunIds,
  input: FixtureStepInput = {},
): AgentEvent {
  const traceId = input.toolUseId ? `${ids.runId}/${input.toolUseId}` : fixtureId("trace");
  return {
    id: fixtureId("event"),
    kind: input.kind ?? "skill-result",
    title: input.title ?? "Fixture step",
    content: input.content ?? "fixture summary",
    status: input.status ?? "success",
    createdAt: new Date(0).toISOString(),
    runId: ids.runId,
    traceId,
    sequence: input.sequence ?? 1,
    toolUseId: input.toolUseId,
    detailRef: traceId,
  };
}

export function createFixtureStepDetail(
  ids: FixtureRunIds,
  input: FixtureStepInput = {},
): AgentStepDetail {
  return {
    traceId: input.toolUseId ? `${ids.runId}/${input.toolUseId}` : ids.traceId,
    runId: ids.runId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    inputSummary: input.inputSummary,
    outputSummary: input.outputSummary,
    errorSummary: input.errorSummary,
    status: input.status ?? "success",
    createdAt: new Date(0).toISOString(),
  };
}

export interface TopologyWaitingConfirmationFixtureInput {
  intent?: string;
  ids?: FixtureRunIds;
  previousProject?: CanonicalTsnProjectV0;
}

export function createTopologyWaitingConfirmationResult(
  input: TopologyWaitingConfirmationFixtureInput = {},
): AgentSuccessResult {
  const intent = input.intent ?? "我需要2个交换机，每个交换机连接2个端系统";
  const ids = input.ids ?? createFixtureRunIds();
  const fallback = input.previousProject ? inferIntentFromProject(input.previousProject) : undefined;
  const project: CanonicalTsnProjectV0 = createProjectFromIntent(intent, fallback);
  const workflow = recordStageResult(normalizeWorkflowState(), {
    step: "topology",
    summary: "已生成拓扑，等待确认",
    waitingConfirmation: true,
  });
  return {
    kind: "success",
    shouldApplyProject: true,
    events: [
      createFixtureAgentEvent(ids, {
        kind: "stage-result",
        title: "拓扑已生成",
        content: "等待用户确认",
        status: "success",
      }),
    ],
    workflow,
    assistantText: "拓扑已生成，请确认或提出修改意见。",
    project,
  };
}

export interface AgentFailurePreservedFixtureInput {
  failureReason?: AgentFailurePreservedStateResult["failureReason"];
  message?: string;
  ids?: FixtureRunIds;
  previousProject?: CanonicalTsnProjectV0;
}

export function createAgentFailurePreservedStateResult(
  input: AgentFailurePreservedFixtureInput = {},
): AgentFailurePreservedStateResult {
  const failureReason = input.failureReason ?? "agent_error";
  const ids = input.ids ?? createFixtureRunIds();
  const message = input.message ?? defaultFailureMessage(failureReason);
  return {
    kind: "failure-preserved",
    shouldApplyProject: false,
    events: [
      createFixtureAgentEvent(ids, {
        kind: "error",
        title: "运行失败",
        content: message,
        status: "error",
      }),
    ],
    workflow: normalizeWorkflowState(),
    assistantText: message,
    failureReason,
    project: input.previousProject,
  };
}

/**
 * Topology stage confirmed → workflow at time-sync waiting_confirmation.
 * For App.test.tsx tests that simulate "用户确认拓扑 → 进入时间同步" stage advance.
 */
export interface TimeSyncWaitingConfirmationFixtureInput {
  intent?: string;
  ids?: FixtureRunIds;
  previousProject?: CanonicalTsnProjectV0;
  assistantText?: string;
}

export function createTimeSyncWaitingConfirmationResult(
  input: TimeSyncWaitingConfirmationFixtureInput = {},
): AgentSuccessResult {
  const intent = input.intent ?? "我需要2个交换机，每个交换机连接2个端系统";
  const ids = input.ids ?? createFixtureRunIds();
  const project = input.previousProject ?? createProjectFromIntent(intent);
  const topologyConfirmed = confirmCurrentStage(
    recordStageResult(normalizeWorkflowState(), {
      step: "topology",
      summary: "已生成拓扑，等待确认",
      waitingConfirmation: true,
    }),
  );
  const workflow = recordStageResult(topologyConfirmed, {
    step: "time-sync",
    summary: "已假设全网时钟同步，等待确认",
    waitingConfirmation: true,
  });
  return {
    kind: "success",
    shouldApplyProject: true,
    events: [
      createFixtureAgentEvent(ids, {
        kind: "stage-result",
        title: "时间同步默认",
        content: "已采用全网时钟同步假设",
        status: "success",
      }),
    ],
    workflow,
    assistantText: input.assistantText ?? "默认假设全网已完成时间同步，请确认或提出修改意见。",
    project,
  };
}

/**
 * Flow-template stage waiting confirmation → workflow advanced through topology and time-sync.
 * project 含 default control flow + 可选业务流。
 */
export interface FlowTemplateWaitingConfirmationFixtureInput {
  intent?: string;
  ids?: FixtureRunIds;
  previousProject?: CanonicalTsnProjectV0;
  flowIntent?: string;
  assistantText?: string;
}

export function createFlowTemplateWaitingConfirmationResult(
  input: FlowTemplateWaitingConfirmationFixtureInput = {},
): AgentSuccessResult {
  const intent = input.intent ?? "我需要2个交换机，每个交换机连接2个端系统";
  const ids = input.ids ?? createFixtureRunIds();
  const baseProject = input.previousProject ?? createProjectFromIntent(intent);
  const projectWithControlFlow = withDefaultControlFlow(baseProject);
  const project = input.flowIntent
    ? withFlowsFromIntent(projectWithControlFlow, input.flowIntent)
    : projectWithControlFlow;
  const topologyConfirmed = confirmCurrentStage(
    recordStageResult(normalizeWorkflowState(), {
      step: "topology",
      summary: "已生成拓扑，等待确认",
      waitingConfirmation: true,
    }),
  );
  const timeSyncConfirmed = confirmCurrentStage(
    recordStageResult(topologyConfirmed, {
      step: "time-sync",
      summary: "时间同步已确认",
      waitingConfirmation: true,
    }),
  );
  const workflow = recordStageResult(timeSyncConfirmed, {
    step: "flow-template",
    summary: "已生成默认控制流，等待确认",
    waitingConfirmation: true,
  });
  return {
    kind: "success",
    shouldApplyProject: true,
    events: [
      createFixtureAgentEvent(ids, {
        kind: "stage-result",
        title: "流量规划",
        content: "已生成默认控制流",
        status: "success",
      }),
    ],
    workflow,
    assistantText: input.assistantText ?? "已生成默认控制流，请确认或描述需要新增的视频/控制流。",
    project,
  };
}

/**
 * Planning-export waiting confirmation → workflow advanced through topology, time-sync, flow-template.
 * planning-export 处于 waiting_confirmation 状态（即「模拟仿真等待确认」），尚未最终确认。
 */
export interface PlanningExportWaitingConfirmationFixtureInput {
  intent?: string;
  ids?: FixtureRunIds;
  previousProject?: CanonicalTsnProjectV0;
  flowIntent?: string;
  assistantText?: string;
}

export function createPlanningExportWaitingConfirmationResult(
  input: PlanningExportWaitingConfirmationFixtureInput = {},
): AgentSuccessResult & { bundle: ArtifactBundle } {
  const intent = input.intent ?? "我需要2个交换机，每个交换机连接2个端系统";
  const ids = input.ids ?? createFixtureRunIds();
  const baseProject = input.previousProject ?? createProjectFromIntent(intent);
  const projectWithControlFlow = withDefaultControlFlow(baseProject);
  const project = input.flowIntent
    ? withFlowsFromIntent(projectWithControlFlow, input.flowIntent)
    : projectWithControlFlow;
  const bundle = createArtifactBundle(project);
  const topologyConfirmed = confirmCurrentStage(
    recordStageResult(normalizeWorkflowState(), {
      step: "topology",
      summary: "拓扑已确认",
      waitingConfirmation: true,
    }),
  );
  const timeSyncConfirmed = confirmCurrentStage(
    recordStageResult(topologyConfirmed, {
      step: "time-sync",
      summary: "时间同步已确认",
      waitingConfirmation: true,
    }),
  );
  const flowConfirmed = confirmCurrentStage(
    recordStageResult(timeSyncConfirmed, {
      step: "flow-template",
      summary: "流量规划已确认",
      waitingConfirmation: true,
    }),
  );
  const workflow = recordStageResult(flowConfirmed, {
    step: "planning-export",
    summary: "已生成导出清单草案，等待确认",
    waitingConfirmation: true,
  });
  return {
    kind: "success",
    shouldApplyProject: true,
    events: [
      createFixtureAgentEvent(ids, {
        kind: "stage-result",
        title: "模拟仿真",
        content: "已生成导出清单草案",
        status: "success",
      }),
    ],
    workflow,
    assistantText: input.assistantText ?? "已生成模拟仿真所需的导出清单草案，请确认或提出修改意见。",
    project,
    bundle,
  };
}

/**
 * Planning-export confirmed → workflow 完结，含 artifact bundle。
 * 用于测试导出按钮、planner 任务起步等终态场景。
 */
export interface PlanningExportConfirmedFixtureInput {
  intent?: string;
  ids?: FixtureRunIds;
  previousProject?: CanonicalTsnProjectV0;
  flowIntent?: string;
  assistantText?: string;
}

export function createPlanningExportConfirmedResult(
  input: PlanningExportConfirmedFixtureInput = {},
): AgentSuccessResult & { bundle: ArtifactBundle } {
  const intent = input.intent ?? "我需要2个交换机，每个交换机连接2个端系统";
  const ids = input.ids ?? createFixtureRunIds();
  const baseProject = input.previousProject ?? createProjectFromIntent(intent);
  const projectWithControlFlow = withDefaultControlFlow(baseProject);
  const project = input.flowIntent
    ? withFlowsFromIntent(projectWithControlFlow, input.flowIntent)
    : projectWithControlFlow;
  const bundle = createArtifactBundle(project);
  const topologyConfirmed = confirmCurrentStage(
    recordStageResult(normalizeWorkflowState(), {
      step: "topology",
      summary: "拓扑已确认",
      waitingConfirmation: true,
    }),
  );
  const timeSyncConfirmed = confirmCurrentStage(
    recordStageResult(topologyConfirmed, {
      step: "time-sync",
      summary: "时间同步已确认",
      waitingConfirmation: true,
    }),
  );
  const flowConfirmed = confirmCurrentStage(
    recordStageResult(timeSyncConfirmed, {
      step: "flow-template",
      summary: "流量规划已确认",
      waitingConfirmation: true,
    }),
  );
  const workflow = confirmCurrentStage(
    recordStageResult(flowConfirmed, {
      step: "planning-export",
      summary: "导出清单已生成",
      waitingConfirmation: true,
    }),
  );
  return {
    kind: "success",
    shouldApplyProject: true,
    events: [
      createFixtureAgentEvent(ids, {
        kind: "stage-result",
        title: "规划导出",
        content: "已生成规划器输入和导出清单",
        status: "success",
      }),
    ],
    workflow,
    assistantText: input.assistantText ?? "已生成规划器输入和导出清单，可在右侧查看 artifact。",
    project,
    bundle,
  };
}

export interface RuntimeUnavailableFixtureInput {
  ctaUrl?: string;
}

export function createRuntimeUnavailableResult(
  input: RuntimeUnavailableFixtureInput = {},
): AgentRuntimeUnavailableResult {
  return {
    kind: "runtime-unavailable",
    shouldApplyProject: false,
    events: [],
    workflow: normalizeWorkflowState(),
    assistantText:
      "智能助手运行时不可用，请下载桌面版以体验完整功能。",
    ctaUrl: input.ctaUrl ?? "https://example.com/desktop",
  };
}

function defaultFailureMessage(
  reason: AgentFailurePreservedStateResult["failureReason"],
): string {
  switch (reason) {
    case "stall_timeout":
      return "运行长时间未推进，已中止；可以重试或简化请求。";
    case "no_stage_result":
      return "智能助手返回了内容，但未收到结构化拓扑结果，已保留当前状态。";
    case "agent_error":
    default:
      return "智能助手返回错误，已保留当前状态。";
  }
}

export function isFixtureResult(value: TsnAgentResult): boolean {
  return Boolean(value);
}
