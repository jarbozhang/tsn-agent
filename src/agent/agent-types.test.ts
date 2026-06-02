import { describe, expect, it } from "vitest";
import {
  CURRENT_SESSION_RUNTIME_VERSION,
  isAgentFailurePreservedState,
  isAgentRuntimeUnavailable,
  isAgentSuccess,
  type AgentFailurePreservedStateResult,
  type AgentRuntimeUnavailableResult,
  type AgentSuccessResult,
  type TsnAgentResult,
} from "./agent-types";
import { normalizeWorkflowState } from "../project/project-state";
import { createProjectFromIntent } from "../topology/topology-factory";

const baseProject = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");

describe("agent-types", () => {
  it("CURRENT_SESSION_RUNTIME_VERSION is at least 1", () => {
    expect(CURRENT_SESSION_RUNTIME_VERSION).toBeGreaterThanOrEqual(1);
  });

  describe("type guards", () => {
    const success: AgentSuccessResult = {
      kind: "success",
      shouldApplyProject: true,
      events: [],
      workflow: normalizeWorkflowState(),
      assistantText: "ok",
      project: baseProject,
    };

    const failure: AgentFailurePreservedStateResult = {
      kind: "failure-preserved",
      shouldApplyProject: false,
      events: [],
      workflow: normalizeWorkflowState(),
      assistantText: "智能助手返回错误，已保留当前状态",
      failureReason: "agent_error",
    };

    const unavailable: AgentRuntimeUnavailableResult = {
      kind: "runtime-unavailable",
      shouldApplyProject: false,
      events: [],
      workflow: normalizeWorkflowState(),
      assistantText: "智能助手运行时不可用",
      ctaUrl: "https://example.com/download",
    };

    it("isAgentSuccess matches only success variant", () => {
      expect(isAgentSuccess(success)).toBe(true);
      expect(isAgentSuccess(failure)).toBe(false);
      expect(isAgentSuccess(unavailable)).toBe(false);
    });

    it("isAgentFailurePreservedState matches only failure-preserved variant", () => {
      expect(isAgentFailurePreservedState(success)).toBe(false);
      expect(isAgentFailurePreservedState(failure)).toBe(true);
      expect(isAgentFailurePreservedState(unavailable)).toBe(false);
    });

    it("isAgentRuntimeUnavailable matches only runtime-unavailable variant", () => {
      expect(isAgentRuntimeUnavailable(success)).toBe(false);
      expect(isAgentRuntimeUnavailable(failure)).toBe(false);
      expect(isAgentRuntimeUnavailable(unavailable)).toBe(true);
    });

    it("three guards partition every TsnAgentResult exactly once", () => {
      const variants: TsnAgentResult[] = [success, failure, unavailable];
      for (const variant of variants) {
        const matches = [
          isAgentSuccess(variant),
          isAgentFailurePreservedState(variant),
          isAgentRuntimeUnavailable(variant),
        ].filter(Boolean).length;
        expect(matches).toBe(1);
      }
    });
  });

  describe("AgentSuccessResult shape", () => {
    it("requires project (compile-time enforced)", () => {
      const success: AgentSuccessResult = {
        kind: "success",
        shouldApplyProject: true,
        events: [],
        workflow: normalizeWorkflowState(),
        assistantText: "",
        project: baseProject,
      };
      expect(success.project).toBeDefined();
      expect(success.shouldApplyProject).toBe(true);
    });
  });

  describe("AgentFailurePreservedStateResult failureReason", () => {
    it("accepts agent_error / stall_timeout / no_stage_result", () => {
      const reasons = ["agent_error", "stall_timeout", "no_stage_result"] as const;
      for (const reason of reasons) {
        const result: AgentFailurePreservedStateResult = {
          kind: "failure-preserved",
          shouldApplyProject: false,
          events: [],
          workflow: normalizeWorkflowState(),
          assistantText: "",
          failureReason: reason,
        };
        expect(result.failureReason).toBe(reason);
      }
    });
  });
});
