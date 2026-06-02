import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { ArtifactBundle } from "../export/artifact-bundle";
import type { WorkflowState, WorkflowStep } from "../workflow/project-state";

export type IsoTimestamp = string;

export type AgentEventKind =
  | "thought"
  | "skill-start"
  | "skill-result"
  | "artifact"
  | "stage-start"
  | "stage-result"
  | "confirmation-required"
  | "tool-availability"
  | "error"
  | "agent_run_aborted";

export type AgentEventStatus =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "pending"
  | "streaming"
  | "aborted"
  | "unknown"
  | "truncated";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  title: string;
  content: string;
  status?: AgentEventStatus;
  stage?: WorkflowStep;
  skillName?: string;
  createdAt?: IsoTimestamp;

  runId?: string;
  traceId?: string;
  sequence?: number;
  toolUseId?: string;
  detailRef?: string;
}

export interface AgentStepDetail {
  traceId: string;
  runId: string;
  toolUseId?: string;
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  errorSummary?: string;
  durationMs?: number;
  counts?: Record<string, number>;
  status: AgentEventStatus;
  createdAt?: IsoTimestamp;
}

export type AgentFailureReason = "agent_error" | "stall_timeout" | "no_stage_result";

interface AgentResultBase {
  events: AgentEvent[];
  workflow: WorkflowState;
  assistantText: string;
  project?: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
}

export interface AgentSuccessResult extends AgentResultBase {
  kind: "success";
  shouldApplyProject: true;
  project: CanonicalTsnProjectV0;
}

export interface AgentFailurePreservedStateResult extends AgentResultBase {
  kind: "failure-preserved";
  shouldApplyProject: false;
  failureReason: AgentFailureReason;
}

export interface AgentRuntimeUnavailableResult extends AgentResultBase {
  kind: "runtime-unavailable";
  shouldApplyProject: false;
  ctaUrl?: string;
}

export type TsnAgentResult =
  | AgentSuccessResult
  | AgentFailurePreservedStateResult
  | AgentRuntimeUnavailableResult;

export function isAgentSuccess(result: TsnAgentResult): result is AgentSuccessResult {
  return result.kind === "success";
}

export function isAgentFailurePreservedState(
  result: TsnAgentResult,
): result is AgentFailurePreservedStateResult {
  return result.kind === "failure-preserved";
}

export function isAgentRuntimeUnavailable(
  result: TsnAgentResult,
): result is AgentRuntimeUnavailableResult {
  return result.kind === "runtime-unavailable";
}

export interface SessionMetadata {
  runtimeVersion?: number;
  legacyFakeOrigin?: boolean;
  legacyOriginAck?: boolean;
}

export const CURRENT_SESSION_RUNTIME_VERSION = 1;
