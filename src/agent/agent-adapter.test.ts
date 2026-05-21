import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { createInitialWorkflowState } from "../project/project-state";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

function createDiagnosticsRecorder() {
  const entries: unknown[] = [];
  const repository: DiagnosticLogRepository = {
    append: vi.fn(async (entry) => {
      entries.push(entry);
    }),
    list: vi.fn(async () => []),
    clearSession: vi.fn(async () => undefined),
  };

  return { repository, entries };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

describe("runTsnAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("uses the deterministic fake agent outside Tauri", async () => {
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("fake");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.bundle).toBeUndefined();
  });

  it("uses Claude output in Tauri while keeping deterministic artifacts", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "Claude 已识别拓扑需求。",
      sessionId: "claude-session-1",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("claude");
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: {
        prompt: "我需要4个交换机，每个交换机连接5个端系统",
        runId: expect.stringMatching(/^claude-run-/),
        appSessionId: undefined,
        conversationContext: expect.stringContaining("交换机：4"),
        resumeSessionId: undefined,
      },
    });
    expect(result.assistantText).toBe("Claude 已识别拓扑需求。");
    expect(result.claudeSessionId).toBe("claude-session-1");
    expect(result.project.topology.nodes).toHaveLength(24);
  });

  it("sends explicit context and forwards streaming chunks", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let eventHandler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_eventName, handler) => {
      eventHandler = handler;
      return unlisten;
    });
    invokeMock.mockImplementation(async (_command, payload) => {
      eventHandler?.({
        payload: {
          runId: payload.request.runId,
          kind: "chunk",
          text: "流式片段",
        },
      });

      return {
        assistantText: "最终回复",
        sessionId: "claude-session-2",
      };
    });
    const chunks: string[] = [];
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续配置时钟",
      onChunk: (chunk) => chunks.push(chunk),
      session: {
        id: "session-1",
        title: "已有会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        claudeSessionId: "claude-session-1",
        messages: [
          {
            id: "message-1",
            role: "user",
            createdAt: "2026-05-20T00:00:00.000Z",
            content: "我需要4个交换机",
          },
        ],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
      },
    });

    expect(chunks).toEqual(["流式片段"]);
    expect(unlisten).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        prompt: "继续配置时钟",
        appSessionId: "session-1",
        resumeSessionId: "claude-session-1",
        conversationContext: expect.stringContaining("我需要4个交换机"),
      }),
    });
    expect(result.claudeSessionId).toBe("claude-session-2");
  });

  it("records diagnostic entries for a Claude run", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "最终回复",
      sessionId: "claude-session-logs",
    });
    const diagnostics = createDiagnosticsRecorder();
    const { runTsnAgent } = await import("./agent-adapter");

    await runTsnAgent({
      userIntent: "我需要4个交换机",
      diagnostics: diagnostics.repository,
      session: {
        id: "session-logs",
        title: "日志会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
      },
    });

    expect(diagnostics.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-logs",
          category: "agent",
          message: "Agent 请求开始",
        }),
        expect.objectContaining({
          sessionId: "session-logs",
          category: "agent",
          message: "Claude Agent 请求完成",
          details: expect.objectContaining({
            claudeSessionId: "claude-session-logs",
          }),
        }),
      ]),
    );
  });

  it("sends the current generated project as authoritative context", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "已按当前 3 交换机拓扑继续。",
      sessionId: "claude-session-3",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "直接生成",
      session: {
        id: "session-1",
        title: "已有会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        claudeSessionId: "claude-session-1",
        messages: [
          {
            id: "message-1",
            role: "user",
            createdAt: "2026-05-20T00:00:00.000Z",
            content: "我需要3个交换机，每个交换机连接3个端系统",
          },
        ],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
        project: createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统"),
      },
    });

    expect(result.project.topology.nodes).toHaveLength(12);
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("交换机：3"),
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("端系统：9"),
      }),
    });
  });

  it("falls back to fake output when Claude command fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockRejectedValue("claude failed");
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("fake");
    expect(result.assistantText).toContain("本机 Claude Code 暂时不可用");
    expect(result.assistantText).toContain("claude failed");
  });

  it("normalizes Error objects when Claude command fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockRejectedValue(new Error("sdk failed"));
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("fake");
    expect(result.assistantText).toContain("sdk failed");
  });
});
