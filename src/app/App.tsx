import { Fragment, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  ScrollText,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { runTsnAgent } from "../agent/agent-adapter";
import {
  artifactBundleSummary,
  logDiagnostic,
  sessionSummary,
  userIntentPreview,
} from "../diagnostics/app-diagnostics";
import {
  createDiagnosticLogRepository,
  type DiagnosticLogRepository,
} from "../diagnostics/diagnostic-log-repository";
import { DiagnosticsLogView } from "../ui/diagnostics/DiagnosticsDrawer";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createArtifactBundle } from "../export/artifact-bundle";
import { exportReactFlowTopology } from "../export/react-flow-exporter";
import { getScenarioConfig } from "../domain/scenario-config";
import {
  exportProjectBundle,
  openProjectExportDirectory,
  selectProjectExportDirectory,
  suggestProjectExportDirectory,
  type ProjectExportResult,
} from "../project/project-exporter";
import {
  createEmptySession,
  createId,
  createSessionRepository,
  type ChatMessage,
  type SessionRepository,
  type TsnSession,
} from "../sessions/session-repository";
import tsnAgentMark from "../assets/tsn-agent-mark.svg";

const repository: SessionRepository = createSessionRepository();
const diagnosticsRepository: DiagnosticLogRepository = createDiagnosticLogRepository();

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

export function App() {
  const initialSession = useMemo(() => createEmptySession(), []);
  const [sessions, setSessions] = useState<TsnSession[]>([initialSession]);
  const [currentSession, setCurrentSession] = useState<TsnSession>(initialSession);
  const [input, setInput] = useState("我需要4个交换机，每个交换机连接5个端系统");
  const [isSessionOpen, setIsSessionOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [exportResult, setExportResult] = useState<ProjectExportResult | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const [exportDirectory, setExportDirectory] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadSessionState() {
      try {
        const session = await repository.ensureCurrentSession();
        const recentSessions = await repository.list();

        if (!cancelled) {
          setCurrentSession(session);
          setSessions(recentSessions.length > 0 ? recentSessions : [session]);
        }
      } catch {
        if (!cancelled) {
          setCurrentSession(initialSession);
          setSessions([initialSession]);
        }
      }
    }

    void loadSessionState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);

    async function loadSuggestedExportDirectory() {
      try {
        const suggestedDirectory = await suggestProjectExportDirectory({ sessionId: currentSession.id });

        if (!cancelled && suggestedDirectory) {
          setExportDirectory(suggestedDirectory);
        }
      } catch {
        // Browser mode does not have a native project directory suggestion.
      }
    }

    void loadSuggestedExportDirectory();

    return () => {
      cancelled = true;
    };
  }, [currentSession.id]);

  const project = currentSession.project;
  const bundle = currentSession.bundle;
  const workflow = currentSession.workflow;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const currentStage = workflow.stages[workflow.currentStep];
  const canExport = Boolean(bundle && workflow.currentStep === "planning-export");
  const canRefreshBundle = Boolean(
    project
      && workflow.currentStep === "planning-export"
      && ["waiting_confirmation", "confirmed"].includes(workflow.stages["planning-export"].status),
  );
  const isFlowStageVisible = workflow.stages["flow-template"].status === "waiting_confirmation"
    || workflow.stages["flow-template"].status === "confirmed";
  const visibleFlows = isFlowStageVisible ? project?.flows ?? [] : [];
  const flowTopology = useMemo(() => (project ? exportReactFlowTopology(project) : undefined), [project]);
  const switchCount = project?.topology.nodes.filter(isSwitch).length ?? 0;
  const endSystemCount = project?.topology.nodes.filter(isEndSystem).length ?? 0;
  const linkCount = project?.topology.links.length ?? 0;
  const flowCount = visibleFlows.length;

  async function persistSession(nextSession: TsnSession) {
    await repository.save(nextSession);
    logDiagnostic(diagnosticsRepository, {
      sessionId: nextSession.id,
      category: "session",
      message: "会话已保存",
      details: sessionSummary(nextSession),
    });
    setCurrentSession(nextSession);
    setSessions(await repository.list());
  }

  async function handleSubmit() {
    await submitIntent(input);
  }

  async function submitIntent(rawInput: string) {
    const trimmedInput = rawInput.trim();

    if (!trimmedInput || isAgentRunning) {
      return;
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: createId("message"),
      role: "user",
      createdAt: now,
      content: trimmedInput,
    };
    const assistantMessage: ChatMessage = {
      id: createId("message"),
      role: "assistant",
      createdAt: now,
      content: "正在连接 Claude，并结合当前会话上下文生成下一步规划...",
    };
    const contextSession = currentSession;
    const pendingSession: TsnSession = {
      ...contextSession,
      updatedAt: now,
      messages: [...contextSession.messages, userMessage, assistantMessage],
    };
    let streamedText = "";

    setInput((value) => (value.trim() === trimmedInput ? "" : value));
    setIsAgentRunning(true);
    setExportResult(undefined);
    setExportError(undefined);
    setCurrentSession(pendingSession);
    logDiagnostic(diagnosticsRepository, {
      sessionId: pendingSession.id,
      category: "session",
      message: "用户提交需求",
      details: userIntentPreview(trimmedInput),
    });

    try {
      await repository.save(pendingSession);
      logDiagnostic(diagnosticsRepository, {
        sessionId: pendingSession.id,
        category: "session",
        message: "pending session 已保存",
        details: sessionSummary(pendingSession),
      });
      setSessions(await repository.list());

      const result = await runTsnAgent({
        userIntent: trimmedInput,
        session: contextSession,
        diagnostics: diagnosticsRepository,
        onChunk: (chunk) => {
          streamedText += chunk;
          updateAssistantMessage(pendingSession.id, assistantMessage.id, streamedText);
        },
      });
      const completedAt = new Date().toISOString();
      const nextSession: TsnSession = {
        ...pendingSession,
        title: result.project.name,
        updatedAt: completedAt,
        messages: pendingSession.messages.map((message) =>
          message.id === assistantMessage.id ? { ...message, content: result.assistantText } : message,
        ),
        claudeSessionId: result.claudeSessionId ?? pendingSession.claudeSessionId,
        agentEvents: [...pendingSession.agentEvents, ...stampAgentEvents(result.events, completedAt)],
        workflow: result.workflow,
        project: result.project,
        bundle: result.bundle,
      };

      if (!(await sessionExists(nextSession.id))) {
        return;
      }

      await repository.save(nextSession);
      logDiagnostic(diagnosticsRepository, {
        sessionId: nextSession.id,
        category: "session",
        message: "final session 已保存",
        details: {
          ...sessionSummary(nextSession),
          agentMode: result.mode,
        },
      });
      if (result.bundle) {
        logDiagnostic(diagnosticsRepository, {
          sessionId: nextSession.id,
          category: "artifact",
          message: "artifact bundle 已生成",
          details: artifactBundleSummary(result.bundle),
        });
      }
      setCurrentSession((session) => (session.id === nextSession.id ? nextSession : session));
      setSessions(await repository.list());
    } catch (error) {
      logDiagnostic(diagnosticsRepository, {
        sessionId: pendingSession.id,
        category: "session",
        level: "error",
        message: "会话生成失败",
        details: {
          error: normalizeError(error),
        },
      });
      setCurrentSession((session) => {
        if (session.id !== pendingSession.id) {
          return session;
        }

        return {
          ...pendingSession,
          messages: pendingSession.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, content: `本次生成失败：${normalizeError(error)}` }
              : message,
          ),
        };
      });
    } finally {
      setIsAgentRunning(false);
    }
  }

  async function sessionExists(sessionId: string) {
    return (await repository.list()).some((session) => session.id === sessionId);
  }

  function updateAssistantMessage(sessionId: string, messageId: string, content: string) {
    setCurrentSession((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      return {
        ...session,
        messages: session.messages.map((message) =>
          message.id === messageId ? { ...message, content } : message,
        ),
      };
    });
  }

  async function handleNewSession() {
    const session = createEmptySession();
    await persistSession(session);
    logDiagnostic(diagnosticsRepository, {
      sessionId: session.id,
      category: "session",
      message: "新建会话",
      details: sessionSummary(session),
    });
    setInput("我需要4个交换机，每个交换机连接5个端系统");
    setIsSessionOpen(false);
  }

  async function handleSelectSession(session: TsnSession) {
    await repository.setCurrent(session.id);
    logDiagnostic(diagnosticsRepository, {
      sessionId: session.id,
      category: "session",
      message: "切换到会话",
      details: sessionSummary(session),
    });
    setCurrentSession(session);
    setIsSessionOpen(false);
  }

  async function handleDuplicateSession() {
    const duplicated = await repository.duplicate(currentSession.id);

    if (duplicated) {
      logDiagnostic(diagnosticsRepository, {
        sessionId: duplicated.id,
        category: "session",
        message: "复制会话",
        details: {
          sourceSessionId: currentSession.id,
          ...sessionSummary(duplicated),
        },
      });
      setCurrentSession(duplicated);
      setExportDirectory("");
      setExportResult(undefined);
      setExportError(undefined);
      setSessions(await repository.list());
      setIsSessionOpen(false);
    }
  }

  async function handleDeleteSession() {
    const deletedSessionId = currentSession.id;
    await repository.remove(currentSession.id);
    await diagnosticsRepository.clearSession(deletedSessionId);
    const nextSession = await repository.ensureCurrentSession();
    logDiagnostic(diagnosticsRepository, {
      sessionId: nextSession.id,
      category: "session",
      message: "删除会话并切换",
      details: {
        deletedSessionId,
        nextSessionId: nextSession.id,
      },
    });
    setCurrentSession(nextSession);
    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);
    setSessions(await repository.list());
    setIsSessionOpen(false);
  }

  async function refreshBundle() {
    if (!project || !canRefreshBundle) {
      return;
    }

    const nextBundle = createArtifactBundle(project);

    logDiagnostic(diagnosticsRepository, {
      sessionId: currentSession.id,
      category: "artifact",
      message: "刷新 artifact bundle",
      details: artifactBundleSummary(nextBundle),
    });

    await persistSession({
      ...currentSession,
      updatedAt: new Date().toISOString(),
      bundle: nextBundle,
      workflow,
    });
  }

  async function handleExportProject() {
    if (!bundle || !canExport) {
      return;
    }

    setExportError(undefined);

    try {
      const outputDir = exportDirectory.trim() || undefined;
      const result = await exportProjectBundle(bundle, outputDir);

      setExportResult(result);
      logDiagnostic(diagnosticsRepository, {
        sessionId: currentSession.id,
        category: "artifact",
        message: "项目文件已导出",
        details: {
          mode: result.mode,
          outputDir: result.outputDir,
          writtenFiles: result.writtenFiles,
        },
      });
    } catch (error) {
      const message = normalizeError(error);
      setExportError(message);
      logDiagnostic(diagnosticsRepository, {
        sessionId: currentSession.id,
        category: "artifact",
        level: "error",
        message: "项目文件导出失败",
        details: {
          error: message,
        },
      });
    }
  }

  async function handleChooseExportDirectory() {
    try {
      const selectedDirectory = await selectProjectExportDirectory(exportDirectory || undefined);

      if (selectedDirectory) {
        setExportDirectory(selectedDirectory);
        setExportError(undefined);
      }
    } catch (error) {
      setExportError(normalizeError(error));
    }
  }

  async function handleOpenExportDirectory() {
    if (!exportResult) {
      return;
    }

    try {
      await openProjectExportDirectory(exportResult.outputDir);
    } catch (error) {
      setExportError(normalizeError(error));
    }
  }

  return (
    <div className="app-shell">
      <header className="brand-header">
        <div className="brand-logo" aria-hidden="true">
          <img src={tsnAgentMark} alt="" />
        </div>
        <h1 className="brand-name">TSN Agent</h1>
        <span className="brand-ver">VER 0.1.0</span>
        <span className={project ? "badge planned" : "badge draft"}>
          <span className="badge-dot" />
          {project ? "草案已生成" : "草稿"}
        </span>
        <div className="brand-spacer" />
        <button className="btn btn-session" type="button" onClick={() => setIsSessionOpen(true)}>
          <FolderOpen size={15} aria-hidden="true" />
          会话
        </button>
        <button className="btn btn-session" type="button" onClick={() => setIsDiagnosticsOpen(true)}>
          <ScrollText size={15} aria-hidden="true" />
          日志
        </button>
      </header>

      {isSessionOpen && (
        <div className="session-overlay" role="presentation" onMouseDown={() => setIsSessionOpen(false)}>
          <aside
            className="session-drawer"
            aria-label="会话管理"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <p className="drawer-kicker">Sessions</p>
                <h2>会话列表</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭会话列表" onClick={() => setIsSessionOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <button className="new-session-button" type="button" onClick={handleNewSession}>
              <Plus size={16} aria-hidden="true" />
              新建会话
            </button>

            <div className="session-list" aria-label="最近会话">
              {sessions.map((session) => (
                <button
                  className={session.id === currentSession.id ? "session-item active" : "session-item"}
                  key={session.id}
                  type="button"
                  onClick={() => handleSelectSession(session)}
                >
                  <div className="session-row1">
                    <span className="session-title">{session.title}</span>
                    <span className="session-time">{formatTime(session.updatedAt)}</span>
                  </div>
                  <p className="session-desc">{session.messages.at(-1)?.content ?? "暂无对话"}</p>
                  <span className={session.project ? "badge planned" : "badge draft"}>
                    <span className="badge-dot" />
                    {session.project ? "配置草案" : "空会话"}
                  </span>
                </button>
              ))}
            </div>

            <div className="drawer-actions">
              <button className="btn" type="button" onClick={handleDuplicateSession}>
                <Copy size={15} aria-hidden="true" />
                复制当前
              </button>
              <button className="btn danger" type="button" onClick={handleDeleteSession}>
                <Trash2 size={15} aria-hidden="true" />
                删除当前
              </button>
            </div>
          </aside>
        </div>
      )}

      {isDiagnosticsOpen && (
        <div className="session-overlay" role="presentation" onMouseDown={() => setIsDiagnosticsOpen(false)}>
          <aside
            className="session-drawer diagnostics-drawer"
            aria-label="诊断日志"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <p className="drawer-kicker">Diagnostics</p>
                <h2>诊断日志</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭诊断日志" onClick={() => setIsDiagnosticsOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <DiagnosticsLogView sessionId={currentSession.id} repository={diagnosticsRepository} />
          </aside>
        </div>
      )}

      <main className="project-layout">
        <section className="chat-pane" aria-label="对话区">
          <div className="project-strip">
            <span className="project-name">当前规划</span>
            <span className="env-badge mono">
              {project ? `canonical=v0 · ${scenarioConfig.displayName}` : scenarioConfig.displayName}
            </span>
          </div>

          <div className="chat-stepper" aria-label="配置步骤">
            {(["topology", "time-sync", "flow-template", "planning-export"] as const).map((step, index, steps) => (
              <Fragment key={step}>
                <Step index={`${index + 1}`} label={scenarioConfig.stageLabels[step]} status={workflow.stages[step].status} />
                {index < steps.length - 1 && (
                  <span className={workflow.stages[step].status === "confirmed" ? "stepper-conn active" : "stepper-conn"} />
                )}
              </Fragment>
            ))}
          </div>

          <div className="messages" aria-live="polite">
            {currentSession.messages.map((message) => (
              <article className={message.role === "user" ? "msg-user" : "msg-agent"} key={message.id}>
                <span className="message-role">{message.role === "user" ? "USER" : "AGENT"}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>

          <div className="composer">
            <label htmlFor="intent">描述你的 TSN 需求</label>
            {currentStage.status === "waiting_confirmation" && (
              <div className="stage-confirmation" role="status">
                <div>
                  <strong>{scenarioConfig.stageLabels[workflow.currentStep]}等待确认</strong>
                  <p>{currentStage.summary}</p>
                </div>
                <button className="btn-primary" type="button" onClick={() => submitIntent("继续")} disabled={isAgentRunning}>
                  确认并继续
                </button>
              </div>
            )}
            <div className="composer-box">
              <textarea
                id="intent"
                aria-label="输入你的 TSN 需求"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
              />
              <button type="button" aria-label="生成规划草案" onClick={handleSubmit} disabled={isAgentRunning}>
                <Send size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>

        <section className="workspace-pane" aria-label="工程状态">
          <div className="topology-stage grid-bg">
            <div className="topology-meta mono">CANONICAL TSN PROJECT · INET 4.x · REACT FLOW</div>
            <div className="topology-stats" aria-label="拓扑统计">
              <Stat label="交换机" value={switchCount} />
              <Stat label="端系统" value={endSystemCount} />
              <Stat label="链路" value={linkCount} />
              <Stat label="控制流" value={flowCount} />
            </div>
            <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
              {flowTopology ? (
                <ReactFlow
                  nodes={flowTopology.nodes}
                  edges={flowTopology.edges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                >
                  <Background />
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : (
                <div className="topology-empty mono">等待 tsn-topology skill 输出拓扑</div>
              )}
            </div>
          </div>

          <div className="config-panel">
            <div className="config-tabs">
              <button className="config-tab active" type="button">流量列表</button>
              <button className="config-tab" type="button">导出文件</button>
              <button className="config-tab" type="button">执行步骤</button>
              <button className="config-tab" type="button" disabled>节点详情</button>
              <button className="config-tab" type="button" disabled>链路详情</button>
              <div className="config-spacer" />
              <span className="config-state mono">配置 · {project ? "草案" : "未生成"}</span>
            </div>

            <div className="config-body">
              <section className="flow-panel" aria-label="流量列表">
                <div className="panel-heading">
                  <div>
                    <h2>控制流模板</h2>
                    <p>先生成 1 条 ST 控制流，用于验证规划器输入链路。</p>
                  </div>
                </div>
                <table className="eng-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Path</th>
                      <th>Period</th>
                      <th>PCP</th>
                      <th>Deadline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFlows.length > 0 ? (
                      visibleFlows.map((flow) => (
                        <tr key={flow.id}>
                          <td>{flow.name}</td>
                          <td>{flow.routeNodeIds.join(" -> ")}</td>
                          <td>{flow.periodUs} us</td>
                          <td>{flow.pcp}</td>
                          <td>{flow.latencyRequirementUs} us</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5}>等待 Agent 生成流模板</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>

              <section className="artifact-panel" aria-label="导出文件列表">
                <div className="panel-heading inline">
                  <div>
                    <h2>导出文件</h2>
                    <p>NED、最小 INET ini、React Flow JSON、规划器输入和 manifest。</p>
                  </div>
                  <button className="btn" type="button" onClick={refreshBundle} disabled={!canRefreshBundle}>
                    <RefreshCw size={14} aria-hidden="true" />
                    刷新
                  </button>
                  <button className="btn" type="button" onClick={handleExportProject} disabled={!canExport}>
                    <Download size={14} aria-hidden="true" />
                    保存
                  </button>
                </div>
                <div className="export-directory">
                  <span>导出目录</span>
                  <div className="export-directory-row">
                    <div className="export-directory-path" aria-label="导出目录">
                      {exportDirectory || "尚未选择目录"}
                    </div>
                    <button
                      className="btn"
                      type="button"
                      aria-label="选择导出目录"
                      onClick={handleChooseExportDirectory}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      选择目录
                    </button>
                  </div>
                </div>
                <div className="artifact-list">
                  {(bundle?.artifacts ?? []).map((artifact) => (
                    <article className="artifact-item" key={artifact.path}>
                      <FileText size={15} aria-hidden="true" />
                      <div>
                        <span>{artifact.path}</span>
                        <p>{artifact.label ?? artifact.purpose}</p>
                      </div>
                    </article>
                  ))}
                  {!bundle && <div className="empty-panel mono">完成“发送规划”阶段后显示导出文件</div>}
                </div>
                {exportResult && (
                  <p className="export-status mono" role="status">
                    已导出 {exportResult.writtenFiles.length} 个文件：{exportResult.outputDir}
                    {exportResult.mode === "tauri" && (
                      <button className="inline-link" type="button" onClick={handleOpenExportDirectory}>
                        <ExternalLink size={13} aria-hidden="true" />
                        打开目录
                      </button>
                    )}
                  </p>
                )}
                {exportError && (
                  <p className="export-status error" role="alert">
                    导出失败：{exportError}
                  </p>
                )}
              </section>

              <section className="steps-panel" aria-label="执行步骤">
                <div className="panel-heading">
                  <h2>执行步骤</h2>
                </div>
                <ol className="event-list">
                  {currentSession.agentEvents.map((event, index) => (
                    <li className={event.kind} key={`${event.id}-${index}`}>
                      <span>{event.skillName ?? event.title}</span>
                      <p>{event.content}</p>
                    </li>
                  ))}
                  {currentSession.agentEvents.length === 0 && <li className="empty-step">等待 Agent 输出</li>}
                </ol>
              </section>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Step({
  index,
  label,
  status,
}: {
  index: string;
  label: string;
  status: "locked" | "current" | "waiting_confirmation" | "confirmed" | "error";
}) {
  const className = status === "confirmed" ? "passed" : status;

  return (
    <div className={`stepper-item ${className}`}>
      <span className="si-num">{index}</span>
      <span className="si-label">{label}</span>
    </div>
  );
}

function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: "switch" | "endSystem";
    portCount?: number;
    ipAddress?: string;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";

  return (
    <div className={`tsn-node ${nodeType}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">
        {nodeType === "switch" ? `${nodeData.portCount ?? 0} ports` : nodeData.ipAddress}
      </small>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="stat-pill">
      <span>{label}</span>
      <strong>
        {label} {value}
      </strong>
    </span>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}

function stampAgentEvents<T extends { id: string; createdAt?: string }>(events: T[], createdAt: string): T[] {
  return events.map((event, index) => ({
    ...event,
    id: `${event.id}-${createdAt.replace(/[^0-9A-Za-z]/g, "")}-${index}`,
    createdAt,
  }));
}
