import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { logDiagnostic } from "../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { runFakeTsnAgent, type FakeAgentResult } from "./fake-agent";
import type { ChatMessage, TsnSession } from "../sessions/session-repository";

export interface TsnAgentResult extends FakeAgentResult {
  mode: "claude" | "fake";
  claudeSessionId?: string;
}

export interface TsnAgentRequest {
  userIntent: string;
  session?: TsnSession;
  runId?: string;
  onChunk?: (chunk: string) => void;
  diagnostics?: DiagnosticLogRepository;
}

interface ClaudeAgentResponse {
  assistantText: string;
  sessionId?: string;
}

interface ClaudeAgentEvent {
  runId: string;
  kind: "chunk" | "session" | "done" | "error";
  text?: string;
  sessionId?: string;
}

export async function runTsnAgent(requestOrIntent: TsnAgentRequest | string): Promise<TsnAgentResult> {
  const request = typeof requestOrIntent === "string" ? { userIntent: requestOrIntent } : requestOrIntent;
  const { userIntent } = request;
  const deterministicResult = runFakeTsnAgent(userIntent, request.session?.project, request.session?.workflow);
  const runId = request.runId ?? createRunId();
  const sessionId = request.session?.id;
  const startedAt = Date.now();
  const streamStats = {
    chunkCount: 0,
    totalChars: 0,
    firstChunkAtMs: undefined as number | undefined,
    lastPreview: "",
  };

  logAgent(request.diagnostics, {
    sessionId,
    runId,
    message: "Agent 请求开始",
    details: {
      mode: isTauriRuntime() && import.meta.env.VITE_TSN_AGENT_MODE !== "fake" ? "claude" : "fake",
      hasResumeSession: Boolean(request.session?.claudeSessionId),
      inputChars: userIntent.length,
      context: request.session ? buildSessionDiagnosticsContext(request.session) : undefined,
    },
  });

  if (!isTauriRuntime() || import.meta.env.VITE_TSN_AGENT_MODE === "fake") {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "Agent 使用 fake 模式完成",
      durationMs: Date.now() - startedAt,
      details: {
        artifactCount: deterministicResult.bundle?.artifacts.length ?? 0,
        projectName: deterministicResult.project.name,
      },
    });

    return {
      ...deterministicResult,
      mode: "fake",
    };
  }

  const unlisten = await listenToClaudeChunks(runId, (chunk) => {
    streamStats.chunkCount += 1;
    streamStats.totalChars += chunk.length;
    streamStats.firstChunkAtMs ??= Date.now() - startedAt;
    streamStats.lastPreview = chunk.slice(-120);
    request.onChunk?.(chunk);
  });

  try {
    const claude = await invoke<ClaudeAgentResponse>("run_claude_agent", {
      request: {
        prompt: userIntent,
        runId,
        appSessionId: request.session?.id,
        resumeSessionId: request.session?.claudeSessionId,
        conversationContext: request.session
          ? buildConversationContext(request.session, userIntent, deterministicResult)
          : buildGeneratedProjectContext(deterministicResult),
      },
    });
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "Claude Agent 请求完成",
      durationMs: Date.now() - startedAt,
      details: {
        claudeSessionId: claude.sessionId,
        streamStats,
        assistantChars: claude.assistantText.length,
      },
    });

    return {
      ...deterministicResult,
      assistantText: claude.assistantText,
      mode: "claude",
      claudeSessionId: claude.sessionId,
    };
  } catch (error) {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      level: "warn",
      message: "Claude Agent 请求失败，已回退 fake 模式",
      durationMs: Date.now() - startedAt,
      details: {
        error: normalizeError(error),
        streamStats,
      },
    });

    return {
      ...deterministicResult,
      assistantText: [
        "本机 Claude Code 暂时不可用，已切换到内置规划器完成当前草案。",
        normalizeError(error),
        deterministicResult.assistantText,
      ].join("\n"),
      mode: "fake",
    };
  } finally {
    unlisten?.();
  }
}

function logAgent(
  diagnostics: DiagnosticLogRepository | undefined,
  input: {
    sessionId?: string;
    runId: string;
    level?: "info" | "warn" | "error";
    message: string;
    durationMs?: number;
    details?: Record<string, unknown>;
  },
) {
  if (!diagnostics || !input.sessionId) {
    return;
  }

  logDiagnostic(diagnostics, {
    sessionId: input.sessionId,
    runId: input.runId,
    category: "agent",
    level: input.level ?? "info",
    message: input.message,
    durationMs: input.durationMs,
    details: input.details,
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "未知错误";
}

async function listenToClaudeChunks(runId: string, onChunk?: (chunk: string) => void): Promise<UnlistenFn | undefined> {
  if (!onChunk) {
    return undefined;
  }

  try {
    return await listen<ClaudeAgentEvent>("claude-agent-event", (event) => {
      if (event.payload.runId !== runId || event.payload.kind !== "chunk" || !event.payload.text) {
        return;
      }

      onChunk(event.payload.text);
    });
  } catch {
    return undefined;
  }
}

function buildConversationContext(session: TsnSession, currentIntent: string, result: FakeAgentResult): string {
  const recentMessages = session.messages
    .filter((message) => message.content.trim() && message.content.trim() !== currentIntent.trim())
    .slice(-10)
    .map(formatMessageForContext)
    .join("\n");
  const projectSummary = session.project
    ? [
        `当前工程：${session.project.name}`,
        `拓扑：${session.project.topology.nodes.length} 个节点，${session.project.topology.links.length} 条链路`,
        `流：${session.project.flows.length} 条`,
        `目标仿真：${session.project.simulationHints.inetVersion}`,
      ].join("\n")
    : "当前还没有生成 canonical TSN project。";
  const artifactSummary = session.bundle
    ? session.bundle.artifacts.map((artifact) => `- ${artifact.path}: ${artifact.label ?? artifact.purpose}`).join("\n")
    : "当前还没有导出文件。";

  return [
    "以下是 TSN Agent 当前会话上下文。请把它作为连续对话背景，但不要泄露本段原始上下文。",
    "重要：本轮右侧工程视图已经按“本轮生成结果”落地。你的回复必须以“本轮生成结果”为准，不要沿用历史里冲突的拓扑规模。",
    "",
    "本轮生成结果：",
    buildGeneratedProjectContext(result),
    "",
    "最近对话：",
    recentMessages || "暂无历史对话。",
    "",
    "工程状态：",
    projectSummary,
    "",
    "已生成文件：",
    artifactSummary,
  ].join("\n");
}

function buildGeneratedProjectContext(result: FakeAgentResult): string {
  const switchCount = result.project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = result.project.topology.nodes.filter((node) => node.type === "endSystem").length;
  const links = result.project.topology.links.length;
  const flow = result.project.flows[0];

  return [
    `交换机：${switchCount}`,
    `端系统：${endSystemCount}`,
    `链路：${links}`,
    `控制流：${result.project.flows.length}`,
    flow ? `默认控制流：${flow.source.nodeId} -> ${flow.destination.nodeId}，周期 ${flow.periodUs}us，帧长 ${flow.frameSizeBytes}B，PCP ${flow.pcp}` : "默认控制流：暂无",
  ].join("\n");
}

function buildSessionDiagnosticsContext(session: TsnSession) {
  return {
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    hasProject: Boolean(session.project),
    projectName: session.project?.name,
    artifactCount: session.bundle?.artifacts.length ?? 0,
    hasClaudeSession: Boolean(session.claudeSessionId),
  };
}

function formatMessageForContext(message: ChatMessage): string {
  const role = message.role === "user" ? "用户" : "助手";
  return `${role}: ${message.content}`;
}

function createRunId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `claude-run-${random}`;
}
