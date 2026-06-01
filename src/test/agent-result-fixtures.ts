import {
  type AgentEvent,
  type AgentFailurePreservedStateResult,
  type AgentRuntimeUnavailableResult,
  type AgentStepDetail,
  type AgentSuccessResult,
  type TsnAgentResult,
} from "../agent/agent-types";
import { createProjectFromIntent } from "../domain/topology-factory";
import { normalizeWorkflowState, recordStageResult } from "../project/project-state";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";

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
}

export function createTopologyWaitingConfirmationResult(
  input: TopologyWaitingConfirmationFixtureInput = {},
): AgentSuccessResult {
  const intent = input.intent ?? "我需要2个交换机，每个交换机连接2个端系统";
  const ids = input.ids ?? createFixtureRunIds();
  const project: CanonicalTsnProjectV0 = createProjectFromIntent(intent);
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
