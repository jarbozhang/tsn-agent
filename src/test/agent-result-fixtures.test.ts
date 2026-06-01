import { describe, expect, it } from "vitest";
import {
  createAgentFailurePreservedStateResult,
  createFixtureAgentEvent,
  createFixtureRunIds,
  createFixtureStepDetail,
  createRuntimeUnavailableResult,
  createTopologyWaitingConfirmationResult,
} from "./agent-result-fixtures";
import {
  isAgentFailurePreservedState,
  isAgentRuntimeUnavailable,
  isAgentSuccess,
} from "../agent/agent-types";

describe("createTopologyWaitingConfirmationResult", () => {
  it("returns success variant with project", () => {
    const result = createTopologyWaitingConfirmationResult();
    expect(isAgentSuccess(result)).toBe(true);
    expect(result.kind).toBe("success");
    expect(result.shouldApplyProject).toBe(true);
    expect(result.project).toBeDefined();
    expect(result.project.topology.nodes.length).toBeGreaterThan(0);
  });

  it("places workflow.topology stage into waiting_confirmation", () => {
    const result = createTopologyWaitingConfirmationResult();
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
  });

  it("contains at least one fixture AgentEvent with runId/traceId", () => {
    const ids = createFixtureRunIds();
    const result = createTopologyWaitingConfirmationResult({ ids });
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events[0].runId).toBe(ids.runId);
    expect(result.events[0].traceId).toBeDefined();
  });

  it("accepts custom intent", () => {
    const result = createTopologyWaitingConfirmationResult({
      intent: "我需要3个交换机，每个交换机连接3个端系统",
    });
    expect(result.project.topology.nodes.filter((node) => node.type === "switch").length).toBe(3);
  });
});

describe("createAgentFailurePreservedStateResult", () => {
  it("returns failure-preserved variant with default agent_error reason", () => {
    const result = createAgentFailurePreservedStateResult();
    expect(isAgentFailurePreservedState(result)).toBe(true);
    expect(result.failureReason).toBe("agent_error");
    expect(result.shouldApplyProject).toBe(false);
  });

  it("supports stall_timeout reason with appropriate message", () => {
    const result = createAgentFailurePreservedStateResult({ failureReason: "stall_timeout" });
    expect(result.failureReason).toBe("stall_timeout");
    expect(result.assistantText).toContain("长时间");
  });

  it("supports no_stage_result reason", () => {
    const result = createAgentFailurePreservedStateResult({ failureReason: "no_stage_result" });
    expect(result.failureReason).toBe("no_stage_result");
  });

  it("preserves previousProject when supplied", () => {
    const previous = createTopologyWaitingConfirmationResult().project;
    const result = createAgentFailurePreservedStateResult({ previousProject: previous });
    expect(result.project).toBe(previous);
  });

  it("emits an error-kind AgentEvent", () => {
    const result = createAgentFailurePreservedStateResult();
    expect(result.events[0].kind).toBe("error");
    expect(result.events[0].status).toBe("error");
  });
});

describe("createRuntimeUnavailableResult", () => {
  it("returns runtime-unavailable variant", () => {
    const result = createRuntimeUnavailableResult();
    expect(isAgentRuntimeUnavailable(result)).toBe(true);
    expect(result.shouldApplyProject).toBe(false);
  });

  it("supplies assistantText containing CTA messaging", () => {
    const result = createRuntimeUnavailableResult();
    expect(result.assistantText).toContain("运行时不可用");
    expect(result.assistantText).toContain("桌面版");
  });

  it("uses custom ctaUrl when provided", () => {
    const result = createRuntimeUnavailableResult({ ctaUrl: "https://my-download/" });
    expect(result.ctaUrl).toBe("https://my-download/");
  });

  it("contains zero AgentEvents (no run actually happened)", () => {
    const result = createRuntimeUnavailableResult();
    expect(result.events).toHaveLength(0);
  });
});

describe("createFixtureAgentEvent / createFixtureStepDetail", () => {
  it("paired toolUseId yields same traceId for event and detail", () => {
    const ids = createFixtureRunIds();
    const event = createFixtureAgentEvent(ids, { toolUseId: "tool_abc" });
    const detail = createFixtureStepDetail(ids, { toolUseId: "tool_abc" });
    expect(event.traceId).toBe(detail.traceId);
    expect(event.detailRef).toBe(detail.traceId);
    expect(detail.toolUseId).toBe("tool_abc");
  });

  it("each call increments fixture counter so ids are unique", () => {
    const ids1 = createFixtureRunIds();
    const ids2 = createFixtureRunIds();
    expect(ids1.runId).not.toBe(ids2.runId);
    expect(ids1.traceId).not.toBe(ids2.traceId);
  });
});
