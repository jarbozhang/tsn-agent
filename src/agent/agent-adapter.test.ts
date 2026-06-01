import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import { runTsnAgent } from "./agent-adapter";
import {
  isAgentFailurePreservedState,
  isAgentRuntimeUnavailable,
  isAgentSuccess,
  type TsnAgentResult,
} from "./agent-types";
import { runTopologyStage } from "../../src-node/stage-skills/tsn-stage-runner";
import { createProjectFromIntent } from "../domain/topology-factory";
import type { TsnSession } from "../sessions/session-repository";
import { createInitialWorkflowState } from "../project/project-state";

const PROMPT = "我需要4个交换机，每个交换机连接5个端系统";

function asUnion(result: Awaited<ReturnType<typeof runTsnAgent>>): TsnAgentResult {
  return result as unknown as TsnAgentResult;
}

function topologyStageResult(intent: string) {
  return runTopologyStage({ userIntent: intent });
}

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
}

function unmockTauriRuntime() {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("runTsnAgent — runtime-unavailable in Web", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    unmockTauriRuntime();
  });

  it("returns runtime-unavailable with CTA url when not in Tauri runtime", async () => {
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(isAgentRuntimeUnavailable(asUnion(result))).toBe(true);
    expect(result.shouldApplyProject).toBe(false);
    expect(result.assistantText).toContain("智能助手运行时不可用");
    expect(result.ctaUrl).toMatch(/^https?:\/\//);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not invoke the Tauri command in Web mode", async () => {
    await runTsnAgent({ userIntent: PROMPT });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not mention vendor names in runtime-unavailable assistantText", async () => {
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(result.assistantText).not.toMatch(/anthropic/i);
    expect(result.assistantText).not.toMatch(/Claude/);
  });
});

describe("runTsnAgent — Tauri runtime success path", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("applies valid topology stage result and returns success", async () => {
    invokeMock.mockResolvedValue({
      assistantText: "拓扑已生成",
      sessionId: "claude-session-1",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(isAgentSuccess(asUnion(result))).toBe(true);
    expect(result.shouldApplyProject).toBe(true);
    expect(result.project?.topology.nodes.length).toBeGreaterThan(0);
    expect(result.claudeSessionId).toBe("claude-session-1");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
  });

  it("rejects stage result when stage does not match current workflow step", async () => {
    invokeMock.mockResolvedValue({
      assistantText: "已生成",
      stageResults: [
        {
          stage: "flow-template",
          status: "success",
          skillName: "tsn-flow-planning",
          summary: "3 条流",
          payload: { project: createProjectFromIntent(PROMPT) },
          validation: { ok: true, errors: [] },
        },
      ],
      agentSteps: [],
    });
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(isAgentFailurePreservedState(asUnion(result))).toBe(true);
    expect(result.failureReason).toBe("no_stage_result");
  });
});

describe("runTsnAgent — failure-preserved path", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("returns failure-preserved with no_stage_result when stageResults are empty", async () => {
    invokeMock.mockResolvedValue({ assistantText: "我说话了", stageResults: [], agentSteps: [] });
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(isAgentFailurePreservedState(asUnion(result))).toBe(true);
    expect(result.failureReason).toBe("no_stage_result");
    expect(result.shouldApplyProject).toBe(false);
    expect(result.assistantText).toContain("没有拿到可应用的结构化结果");
  });

  it("returns failure-preserved with previous project preserved when session has project", async () => {
    const previousProject = createProjectFromIntent(PROMPT);
    const session: TsnSession = {
      id: "s2",
      title: "preserved",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      messages: [],
      agentEvents: [],
      workflow: createInitialWorkflowState(),
      project: previousProject,
    };
    invokeMock.mockResolvedValue({ assistantText: "结果未通过", stageResults: [], agentSteps: [] });
    const result = await runTsnAgent({ userIntent: PROMPT, session });
    expect(isAgentFailurePreservedState(asUnion(result))).toBe(true);
    expect(result.project).toBe(previousProject);
  });

  it("returns failure-preserved with agent_error when invoke throws", async () => {
    invokeMock.mockRejectedValue(new Error("worker exploded"));
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(isAgentFailurePreservedState(asUnion(result))).toBe(true);
    expect(result.failureReason).toBe("agent_error");
    expect(result.shouldApplyProject).toBe(false);
    expect(result.project).toBeUndefined();
  });

  it("preserves project when invoke throws and session has project", async () => {
    const previousProject = createProjectFromIntent(PROMPT);
    const session: TsnSession = {
      id: "s3",
      title: "preserve",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      messages: [],
      agentEvents: [],
      workflow: createInitialWorkflowState(),
      project: previousProject,
    };
    invokeMock.mockRejectedValue(new Error("timeout"));
    const result = await runTsnAgent({ userIntent: PROMPT, session });
    expect(result.failureReason).toBe("agent_error");
    expect(result.project).toBe(previousProject);
  });
});

describe("runTsnAgent — vendor name redaction in error paths", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("redacts vendor names in agent_error message", async () => {
    invokeMock.mockRejectedValue(new Error("anthropic API returned 401 from api.anthropic.com (x-request-id: req_xyz)"));
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(result.assistantText).not.toMatch(/anthropic/i);
    expect(result.assistantText).not.toMatch(/Claude/);
    expect(result.assistantText).not.toContain("api.anthropic.com");
    expect(result.events[0]?.content).not.toMatch(/anthropic/i);
  });

  it("redacts vendor names in error model identifiers", async () => {
    invokeMock.mockRejectedValue(new Error("model claude-sonnet-4-5-20250929 unavailable"));
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(result.assistantText).not.toContain("claude-sonnet");
  });

  it("redacts vendor names in runtime-unavailable assistantText", async () => {
    unmockTauriRuntime();
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(result.assistantText).not.toMatch(/anthropic/i);
    expect(result.assistantText).not.toMatch(/Claude/);
  });
});

describe("runTsnAgent — legacy fake-mode session compatibility", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("still invokes real Agent for sessions marked legacyFakeOrigin", async () => {
    const session: TsnSession = {
      id: "legacy",
      title: "legacy",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      messages: [],
      agentEvents: [],
      workflow: createInitialWorkflowState(),
      metadata: { runtimeVersion: 1, legacyFakeOrigin: true },
    };
    invokeMock.mockResolvedValue({
      assistantText: "已生成",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    const result = await runTsnAgent({ userIntent: PROMPT, session });
    expect(invokeMock).toHaveBeenCalled();
    expect(isAgentSuccess(asUnion(result))).toBe(true);
  });
});

describe("runTsnAgent — sanitize claude assistant text", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("replaces unsupported simulation claims with safe alternative", async () => {
    invokeMock.mockResolvedValue({
      assistantText: "已启动仿真，稍后通知结果",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(result.assistantText).toContain("仿真");
    expect(result.assistantText).not.toContain("已启动仿真");
  });

  it("does not include trace prefixes in assistantText", async () => {
    invokeMock.mockResolvedValue({
      assistantText: "拓扑已生成",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    const result = await runTsnAgent({ userIntent: PROMPT });
    expect(result.assistantText).not.toContain("[工具]");
    expect(result.assistantText).not.toContain("[工具结果]");
    expect(result.assistantText).not.toContain("[Skill]");
  });
});

describe("runTsnAgent — stall-timer watchdog", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("triggers stall_timeout when worker stops responding within stall timer window", async () => {
    invokeMock.mockImplementation(() => new Promise(() => undefined));
    const result = await runTsnAgent({ userIntent: PROMPT, stallTimeoutMs: 30 });
    expect(isAgentFailurePreservedState(asUnion(result))).toBe(true);
    expect(result.failureReason).toBe("stall_timeout");
    expect(result.events[0]?.kind).toBe("agent_run_aborted");
    expect(result.events[0]?.status).toBe("aborted");
  });

  it("does not trigger stall_timeout when invoke completes before stall timer fires", async () => {
    invokeMock.mockResolvedValue({
      assistantText: "ok",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    const result = await runTsnAgent({ userIntent: PROMPT, stallTimeoutMs: 5_000 });
    expect(isAgentSuccess(asUnion(result))).toBe(true);
  });
});

describe("runTsnAgent — invoke args", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    mockTauriRuntime();
  });

  it("forwards runId when provided and uses generated runId otherwise", async () => {
    invokeMock.mockResolvedValue({
      assistantText: "ok",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    await runTsnAgent({ userIntent: PROMPT, runId: "fixed-run-1" });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", expect.objectContaining({
      request: expect.objectContaining({ runId: "fixed-run-1" }),
    }));

    invokeMock.mockClear();
    await runTsnAgent({ userIntent: PROMPT });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", expect.objectContaining({
      request: expect.objectContaining({ runId: expect.stringMatching(/agent-run-/) }),
    }));
  });

  it("passes session id and stage runner input through", async () => {
    const session: TsnSession = {
      id: "session-id-x",
      title: "test",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      messages: [],
      agentEvents: [],
      workflow: createInitialWorkflowState(),
      claudeSessionId: "claude-prev-session",
    };
    invokeMock.mockResolvedValue({
      assistantText: "ok",
      stageResults: [topologyStageResult(PROMPT)],
      agentSteps: [],
    });
    await runTsnAgent({ userIntent: PROMPT, session });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", expect.objectContaining({
      request: expect.objectContaining({
        prompt: PROMPT,
        appSessionId: "session-id-x",
        resumeSessionId: "claude-prev-session",
        stageRunnerInput: expect.objectContaining({
          userIntent: PROMPT,
          stage: "topology",
        }),
      }),
    }));
  });
});
