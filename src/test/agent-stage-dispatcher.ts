/**
 * Test-only stage dispatcher. Lives under `src/test/` to keep it out of the
 * production agent surface area.
 *
 * Replaces `fake-agent.ts` (562 lines of natural-language intent parsing) with
 * a focused ~80 line stage advancer that:
 *   1. Detects intent class (initial submission / confirmation / topology edit /
 *      flow addition) using narrow regex
 *   2. Composes the appropriate fixture using `agent-result-fixtures` + production
 *      domain helpers (`createProjectFromIntent`, `withFlowsFromIntent`)
 *
 * Plan 2026-06-01-002 U4 demanded fake-agent be removed and natural-language
 * stage-advance tests "移到真实 Agent E2E 或 prompt/skill 层". For App.test.tsx
 * multi-stage UI tests that aren't E2E candidates yet, this dispatcher is the
 * deterministic alternative — production agent code never imports it.
 *
 * **DO NOT import this from production code.** Production must go through
 * `src/agent/agent-adapter.ts` and its three-state fail-closed result.
 */
import {
  createFlowTemplateWaitingConfirmationResult,
  createPlanningExportConfirmedResult,
  createPlanningExportWaitingConfirmationResult,
  createTimeSyncWaitingConfirmationResult,
  createTopologyWaitingConfirmationResult,
} from "./agent-result-fixtures";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { WorkflowState } from "../project/project-state";
import type { TsnAgentResult } from "../agent/agent-types";

const CONFIRMATION_PATTERN =
  /^(继续|确认|可以|好的|没问题|对|正确|按这个|就这样|同意|通过|采用|默认|下一步)\s*[。.!！]?$/;
const TOPOLOGY_EDIT_PATTERN =
  /\d+\s*(?:个|台|块|张)\s*(?:交换机|端系统|网卡|端)|改成\s*\d+|环[形型]|line\b|ring\b|互联/i;
const FLOW_INTENT_PATTERN = /(视频流|控制流|业务流|流量|新增|添加|加一条|加.*流)/;
const STAGE_ADVANCE_PATTERN = /开始.*(时间同步|流量规划|控制流|建立流|配置流)|进入.*(时间同步|流量规划)/;

export interface DispatchInput {
  userIntent: string;
  session?: {
    project?: CanonicalTsnProjectV0;
    workflow?: WorkflowState;
  };
}

/**
 * Default stage dispatcher for App.test.tsx multi-stage workflows. Returns the
 * fixture matching what a real agent would return for the given intent given
 * the current session state.
 */
export function dispatchAgentStage(input: DispatchInput): TsnAgentResult {
  const intent = input.userIntent.trim();
  const project = input.session?.project;
  const workflow = input.session?.workflow;
  const currentStep = workflow?.currentStep ?? "topology";
  const currentStatus = workflow?.stages?.[currentStep]?.status;
  const isConfirm = CONFIRMATION_PATTERN.test(intent) || STAGE_ADVANCE_PATTERN.test(intent);
  const isTopologyEdit = TOPOLOGY_EDIT_PATTERN.test(intent);
  const isFlowAdd = FLOW_INTENT_PATTERN.test(intent);

  // No project yet → initial topology
  if (!project) {
    return createTopologyWaitingConfirmationResult({ intent });
  }

  // Topology edit while staying at topology stage — preserve previous project as
  // intent fallback so unspecified counts (e.g. ring-only edits) keep prior state.
  if (currentStep === "topology" && isTopologyEdit && !isConfirm) {
    return createTopologyWaitingConfirmationResult({ intent, previousProject: project });
  }

  // Confirmation advances to next stage. planning-export has two waiting steps:
  // first generation → waiting_confirmation, then user confirms → fully confirmed.
  if (currentStatus === "waiting_confirmation" && isConfirm) {
    if (currentStep === "topology") {
      return createTimeSyncWaitingConfirmationResult({ previousProject: project });
    }
    if (currentStep === "time-sync") {
      return createFlowTemplateWaitingConfirmationResult({ previousProject: project });
    }
    if (currentStep === "flow-template") {
      return createPlanningExportWaitingConfirmationResult({ previousProject: project });
    }
    // planning-export waiting_confirmation → user confirms → final terminal state.
    return createPlanningExportConfirmedResult({ previousProject: project });
  }

  // Flow addition at flow-template stage
  if (currentStep === "flow-template" && isFlowAdd) {
    return createFlowTemplateWaitingConfirmationResult({
      previousProject: project,
      flowIntent: intent,
    });
  }

  // Default fallback: stay at topology waiting confirmation with the new intent
  return createTopologyWaitingConfirmationResult({ intent, previousProject: project });
}
