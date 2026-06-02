import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useSessionRepository } from "./hooks/use-session-repository";
import { useAgentRunController, type AgentRunPhase } from "./hooks/use-agent-run-controller";
import { usePlannerRun, bundleForAgentResult, plannerRunForAgentResult } from "./hooks/use-planner-run";
import { useProjectExport } from "./hooks/use-project-export";
import { WorkspaceToolRail, WorkspaceToolDrawer, type WorkspaceToolPanel } from "./components/workspace-tools";
import { Stat, DetailRow, formatTime } from "./components/shared";
import {
  AgentRunStatusBar,
  AgentStepSummaryGroup,
  AgentWaitingIndicator,
  LegacyOriginBanner,
  Step,
  TelegramSendIcon,
  stampAgentEvents,
} from "./components/chat-pane";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { runTsnAgent } from "../agent/agent-adapter";
import type { AgentEvent, AgentStepDetail } from "../agent/agent-types";
import {
  artifactBundleSummary,
  logDiagnostic,
  plannerRunSummary,
  sessionSummary,
  userIntentPreview,
} from "../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { DiagnosticsLogView } from "../ui/diagnostics/DiagnosticsDrawer";
import { SkillFilePreview } from "../ui/skills/SkillFilePreview";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createArtifactBundle, type ExportedArtifact } from "../export/artifact-bundle";
import { classifyArtifact, type ArtifactClassification, type ArtifactGroupId } from "../export/artifact-classification";
import { exportPlannerInput } from "../export/planner-exporter";
import { exportReactFlowTopology } from "../export/react-flow-exporter";
import {
  PLANNER_LINK_DEFAULTS,
  PLANNER_NODE_PARAMETER_DEFAULTS,
} from "../planner/planner-defaults";
import {
  getPlannerPlanResult,
  queryPlannerPlanStatus,
  startPlannerPlan,
  stopPlannerPlan,
} from "../planner/planner-client";
import {
  createPlannerRequestFingerprint,
  createStalePlannerRunState,
  isTerminalPlannerState,
  normalizePlannerRunState,
  resolvePlannerBaseUrl,
  summarizePlannerRequest,
  summarizePlannerResult,
  type PlannerQueryStatusResponseData,
  type PlannerResultResponseData,
  type PlannerRunState,
  type PlannerServiceEnvelope,
  type PlannerStartResponseData,
  type PlannerTaskState,
} from "../planner/planner-contract";
import { getScenarioConfig } from "../domain/scenario-config";
import {
  exportProjectBundle,
  openProjectExportDirectory,
  selectProjectExportDirectory,
  suggestProjectExportDirectory,
  type ProjectExportResult,
} from "../workflow/project-exporter";
import { appVersion, releaseNotes, type ReleaseNote } from "../release/release-info";
import {
  createId,
  type ChatMessage,
  type TsnSession,
} from "../sessions/session-repository";
import {
  SKILL_CATALOG,
  type SkillCatalogItem,
} from "../skills/skill-catalog";
import tsnAgentMark from "../assets/tsn-agent-mark.png";

const ASSISTANT_CONNECTING_MESSAGE = "正在连接智能助手，并结合当前会话上下文生成下一步规划...";
const INTENT_PLACEHOLDER = "例如：我需要 4 个交换机，每个交换机连接 5 个端系统";
const PLANNER_POLL_INTERVAL_MS = import.meta.env.MODE === "test" ? 20 : 3000;
const PLANNER_TRANSIENT_FAILURE_RETRY_LIMIT = 2;

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

type ConfigTabId = "flows" | "node-detail" | "link-detail" | "artifacts";

type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "flows", label: "流量列表" },
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
  { id: "artifacts", label: "导出文件" },
];

const ARTIFACT_GROUP_ORDER: ArtifactGroupId[] = ["workspace", "planner", "simulation-inet", "manifest", "legacy"];

export function App() {
  const {
    sessions,
    currentSession,
    setCurrentSession,
    repository,
    persistSession,
    persistSessionIfCurrent,
    sessionExists,
    updateAssistantMessage,
    reloadSessionsList,
    handleNewSession: hookHandleNewSession,
    handleSelectSession: hookHandleSelectSession,
    handleDuplicateSession: hookHandleDuplicateSession,
    handleDeleteSession: hookHandleDeleteSession,
    diagnostics: diagnosticsRepository,
  } = useSessionRepository();
  const [input, setInput] = useState("");
  const [activeWorkspacePanel, setActiveWorkspacePanel] = useState<WorkspaceToolPanel | undefined>();
  const {
    isAgentRunning,
    agentRunPhase,
    agentRunStartedAt,
    agentRunElapsedSeconds,
    pendingAssistantMessageId,
    scrollContainerRef: messagesContainerRef,
    actions: agentRunActions,
  } = useAgentRunController({
    scrollDeps: [currentSession.id, currentSession.messages],
  });
  const [expandedStepTraceId, setExpandedStepTraceId] = useState<string | undefined>();
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("flows");
  const [selectedTopologyItem, setSelectedTopologyItem] = useState<SelectedTopologyItem | undefined>();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>();
  const {
    plannerRun,
    plannerBaseUrl,
    setPlannerBaseUrl,
    isPlannerActionRunning,
    canStartPlanner,
    canStopPlanner,
    currentPlannerRequestFingerprint,
    plannerResultForCurrentProject,
    handleStartPlanner,
    handleStopPlanner,
  } = usePlannerRun({
    currentSession,
    repository,
    diagnostics: diagnosticsRepository,
    onPersistedSession: (next) => setCurrentSession((s) => (s.id === next.id ? next : s)),
    onPlannerStart: () => {
      setExportErrorRef.current?.(undefined);
      setActiveConfigTab("artifacts");
    },
  });
  const {
    exportDirectory,
    setExportDirectory,
    exportResult,
    exportError,
    setExportResult,
    setExportError,
    canExport,
    canRefreshBundle,
    refreshBundle,
    handleExportProject,
    handleChooseExportDirectory,
    handleOpenExportDirectory,
  } = useProjectExport({
    currentSession,
    diagnostics: diagnosticsRepository,
    persistSession,
    plannerResultForCurrentProject,
  });
  const setExportErrorRef = useRef<typeof setExportError | undefined>(undefined);
  setExportErrorRef.current = setExportError;

  useEffect(() => {
    setActiveConfigTab("flows");
    setSelectedTopologyItem(undefined);
    setSelectedFlowId(undefined);
  }, [currentSession.id]);

  const project = currentSession.project;
  const bundle = currentSession.bundle;
  const workflow = currentSession.workflow;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const currentStage = workflow.stages[workflow.currentStep];
  const hasUserInteraction = currentSession.messages.some((message) => message.role === "user");
  const isFlowStageVisible = workflow.stages["flow-template"].status === "waiting_confirmation"
    || workflow.stages["flow-template"].status === "confirmed";
  const visibleFlows = isFlowStageVisible ? project?.flows ?? [] : [];
  const selectedFlow = visibleFlows.find((flow) => flow.id === selectedFlowId);
  const flowTopology = useMemo(() => {
    if (!project) {
      return undefined;
    }

    const topology = exportReactFlowTopology(project);

    if (!selectedFlow) {
      return topology;
    }

    const routeNodeIds = new Set(selectedFlow.routeNodeIds);
    const routeLinkIds = new Set(selectedFlow.routeLinkIds);
    const routeEdgeDirections = new Map(
      selectedFlow.routeLinkIds.map((linkId, index) => [
        linkId,
        {
          source: selectedFlow.routeNodeIds[index],
          target: selectedFlow.routeNodeIds[index + 1],
        },
      ]),
    );

    return {
      ...topology,
      nodes: topology.nodes.map((node) => ({
        ...node,
        className: routeNodeIds.has(node.id) ? "flow-highlighted" : "flow-muted",
        data: {
          ...node.data,
          highlightedByFlow: routeNodeIds.has(node.id),
        },
      })),
      edges: topology.edges.map((edge) => ({
        ...edge,
        ...(routeEdgeDirections.get(edge.id) ?? {}),
        animated: routeLinkIds.has(edge.id),
        className: routeLinkIds.has(edge.id) ? "flow-highlighted" : "flow-muted",
      })),
    };
  }, [project, selectedFlow]);
  const selectedNode = selectedTopologyItem?.kind === "node"
    ? project?.topology.nodes.find((node) => node.id === selectedTopologyItem.id)
    : undefined;
  const selectedLink = selectedTopologyItem?.kind === "link"
    ? project?.topology.links.find((link) => link.id === selectedTopologyItem.id)
    : undefined;
  const selectedLinkSourceNode = selectedLink
    ? project?.topology.nodes.find((node) => node.id === selectedLink.source.nodeId)
    : undefined;
  const selectedLinkTargetNode = selectedLink
    ? project?.topology.nodes.find((node) => node.id === selectedLink.target.nodeId)
    : undefined;
  const switchCount = project?.topology.nodes.filter(isSwitch).length ?? 0;
  const endSystemCount = project?.topology.nodes.filter(isEndSystem).length ?? 0;
  const linkCount = project?.topology.links.length ?? 0;
  const flowCount = visibleFlows.length;
  const artifactGroups = useMemo(() => groupArtifacts(bundle?.artifacts ?? []), [bundle]);

  useEffect(() => {
    if (!project || !selectedTopologyItem) {
      return;
    }

    const stillExists = selectedTopologyItem.kind === "node"
      ? project.topology.nodes.some((node) => node.id === selectedTopologyItem.id)
      : project.topology.links.some((link) => link.id === selectedTopologyItem.id);

    if (!stillExists) {
      setSelectedTopologyItem(undefined);
    }
  }, [project, selectedTopologyItem]);

  useEffect(() => {
    if (!selectedFlowId || visibleFlows.some((flow) => flow.id === selectedFlowId)) {
      return;
    }

    setSelectedFlowId(undefined);
  }, [selectedFlowId, visibleFlows]);


  async function handleSubmit() {
    await submitIntent(input);
  }

  async function submitIntent(rawInput: string) {
    const trimmedInput = rawInput.trim();

    if (!trimmedInput || isAgentRunning) {
      return;
    }

    const now = new Date().toISOString();
    const pendingRunId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `agent-run-${crypto.randomUUID()}`
      : `agent-run-${Math.random().toString(36).slice(2)}`;
    const userMessage: ChatMessage = {
      id: createId("message"),
      role: "user",
      createdAt: now,
      content: trimmedInput,
      runId: pendingRunId,
    };
    const assistantMessage: ChatMessage = {
      id: createId("message"),
      role: "assistant",
      createdAt: now,
      content: ASSISTANT_CONNECTING_MESSAGE,
      runId: pendingRunId,
    };
    const contextSession = currentSession;
    const pendingSession: TsnSession = {
      ...contextSession,
      updatedAt: now,
      messages: [...contextSession.messages, userMessage, assistantMessage],
    };
    let streamedText = "";

    setInput((value) => (value.trim() === trimmedInput ? "" : value));
    agentRunActions.startRun();
    agentRunActions.setPendingAssistantMessageId(assistantMessage.id);
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
      await reloadSessionsList();

      const runId = pendingRunId;
      const inFlightStepBuffer: Record<string, AgentStepDetail> = {};
      const result = await runTsnAgent({
        userIntent: trimmedInput,
        session: contextSession,
        runId,
        diagnostics: diagnosticsRepository,
        onChunk: (chunk) => {
          streamedText += chunk;
          agentRunActions.markStreaming();
          agentRunActions.recordChunkAt(Date.now());
          agentRunActions.setPendingAssistantMessageId(undefined);
          updateAssistantMessage(pendingSession.id, assistantMessage.id, redactProviderNamesForDisplay(streamedText));
        },
        onAgentStep: (step) => {
          if (typeof step?.traceId === "string" && step.traceId.length > 0) {
            inFlightStepBuffer[step.traceId] = { ...inFlightStepBuffer[step.traceId], ...(step as AgentStepDetail) };
          }
        },
      });
      const completedAt = new Date().toISOString();
      const shouldApplyProject = result.shouldApplyProject !== false && Boolean(result.project);
      const appliedProject = shouldApplyProject ? result.project! : undefined;
      const latestSession = (await repository.list()).find((session) => session.id === pendingSession.id) ?? pendingSession;
      const baseMessages = latestSession.messages.some((message) => message.id === assistantMessage.id)
        ? latestSession.messages
        : pendingSession.messages;
      const previousPlannerRun = normalizePlannerRunState(latestSession.plannerRun);
      const nextPlannerRun: PlannerRunState = appliedProject
        ? plannerRunForAgentResult(previousPlannerRun, appliedProject)
        : previousPlannerRun;
      const mergedStepDetails: Record<string, AgentStepDetail> = {
        ...(latestSession.agentStepDetails ?? {}),
        ...inFlightStepBuffer,
      };
      for (const step of result.agentSteps ?? []) {
        if (step?.traceId) {
          mergedStepDetails[step.traceId] = step;
        }
      }
      const nextSession: TsnSession = {
        ...latestSession,
        title: appliedProject ? appliedProject.name : pendingSession.title,
        updatedAt: completedAt,
        messages: baseMessages.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: redactProviderNamesForDisplay(result.assistantText),
                cta:
                  result.kind === "runtime-unavailable" && result.ctaUrl
                    ? { label: "下载桌面版", url: result.ctaUrl }
                    : undefined,
              }
            : message,
        ),
        claudeSessionId: result.claudeSessionId ?? latestSession.claudeSessionId,
        agentEvents: [...latestSession.agentEvents, ...stampAgentEvents(result.events, completedAt)],
        agentStepDetails: mergedStepDetails,
        workflow: shouldApplyProject ? result.workflow : pendingSession.workflow,
        project: appliedProject ?? pendingSession.project,
        bundle: appliedProject
          ? bundleForAgentResult(appliedProject, result.bundle, nextPlannerRun)
          : pendingSession.bundle,
        plannerRun: nextPlannerRun,
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
      await reloadSessionsList();
    } catch (error) {
      setInput(trimmedInput);
      agentRunActions.setPendingAssistantMessageId(undefined);
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
              ? { ...message, content: `本次生成失败：${redactProviderNamesForDisplay(normalizeError(error))}` }
              : message,
          ),
        };
      });
    } finally {
      agentRunActions.finishRun();
    }
  }

  async function handleNewSession() {
    await hookHandleNewSession();
    setInput("我需要4个交换机，每个交换机连接5个端系统");
    setActiveWorkspacePanel(undefined);
  }

  async function handleSelectSession(session: TsnSession) {
    await hookHandleSelectSession(session);
    setActiveWorkspacePanel(undefined);
  }

  async function handleDuplicateSession() {
    const duplicated = await hookHandleDuplicateSession();
    if (duplicated) {
      setExportDirectory("");
      setExportResult(undefined);
      setExportError(undefined);
      setActiveWorkspacePanel(undefined);
    }
  }

  async function handleDeleteSession() {
    await hookHandleDeleteSession();
    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);
    setActiveWorkspacePanel(undefined);
  }

  function handleNodeSelect(_event: unknown, node: Node) {
    setSelectedTopologyItem({ kind: "node", id: node.id });
    setActiveConfigTab("node-detail");
  }

  function handleLinkSelect(_event: unknown, edge: Edge) {
    setSelectedTopologyItem({ kind: "link", id: edge.id });
    setActiveConfigTab("link-detail");
  }

  function handleFlowSelect(flowId: string) {
    setSelectedFlowId((currentFlowId) => (currentFlowId === flowId ? undefined : flowId));
  }

  return (
    <div className="app-shell" aria-busy={isAgentRunning}>
      <header className="brand-header">
        <div className="brand-logo" aria-hidden="true">
          <img src={tsnAgentMark} alt="" />
        </div>
        <h1 className="brand-name">TSN Agent</h1>
        <span className="brand-ver">VER {appVersion}</span>
        <span className={project ? "badge planned" : "badge draft"}>
          <span className="badge-dot" />
          {project ? "草案已生成" : "草稿"}
        </span>
        <div className="brand-spacer" />
      </header>

      {isAgentRunning && <AgentRunStatusBar elapsedSeconds={agentRunElapsedSeconds} phase={agentRunPhase} />}

      <main className="project-layout">
        <WorkspaceToolRail
          activePanel={activeWorkspacePanel}
          onSelectPanel={(panel) => setActiveWorkspacePanel((current) => (current === panel ? undefined : panel))}
        />
        {activeWorkspacePanel && (
          <WorkspaceToolDrawer
            activePanel={activeWorkspacePanel}
            currentSession={currentSession}
            diagnosticsRepository={diagnosticsRepository}
            sessions={sessions}
            appVersion={appVersion}
            onClose={() => setActiveWorkspacePanel(undefined)}
            onDeleteSession={handleDeleteSession}
            onDuplicateSession={handleDuplicateSession}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
          />
        )}
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

          <div className="messages" aria-live="polite" ref={messagesContainerRef}>
            {currentSession.metadata?.legacyFakeOrigin && !currentSession.metadata?.legacyOriginAck && (
              <LegacyOriginBanner
                onAcknowledge={async () => {
                  const updated: TsnSession = {
                    ...currentSession,
                    metadata: { ...currentSession.metadata, legacyOriginAck: true },
                  };
                  await repository.save(updated);
                  setCurrentSession(updated);
                  await reloadSessionsList();
                }}
              />
            )}
            {currentSession.messages.map((message) => (
              <Fragment key={message.id}>
                <article
                  className={[
                    message.role === "user" ? "msg-user" : "msg-agent",
                    message.id === pendingAssistantMessageId ? "pending" : "",
                  ].filter(Boolean).join(" ")}
                >
                  <span className="message-role">{message.role === "user" ? "USER" : "AGENT"}</span>
                  {message.id === pendingAssistantMessageId ? (
                    <AgentWaitingIndicator />
                  ) : (
                    <p>{message.role === "assistant" ? redactProviderNamesForDisplay(message.content) : message.content}</p>
                  )}
                  {message.cta && (
                    <a
                      className="btn-primary message-cta"
                      href={message.cta.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {message.cta.label}
                    </a>
                  )}
                </article>
                {message.role === "user" && message.runId && (
                  <AgentStepSummaryGroup
                    runId={message.runId}
                    events={currentSession.agentEvents}
                    stepDetails={currentSession.agentStepDetails}
                    expandedTraceId={expandedStepTraceId}
                    onToggleExpanded={(traceId) =>
                      setExpandedStepTraceId((current) => (current === traceId ? undefined : traceId))
                    }
                  />
                )}
              </Fragment>
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
                placeholder={INTENT_PLACEHOLDER}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
              />
              <button type="button" aria-label="生成规划草案" onClick={handleSubmit} disabled={isAgentRunning || !input.trim()}>
                <TelegramSendIcon />
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
              <Stat label="流量" value={flowCount} />
            </div>
            <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
              {flowTopology ? (
                <ReactFlow
                  nodes={flowTopology.nodes}
                  edges={flowTopology.edges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                  onNodeClick={handleNodeSelect}
                  onEdgeClick={handleLinkSelect}
                >
                  <Background />
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : (
                <div className="topology-empty mono">
                  {isAgentRunning
                    ? "正在生成拓扑图"
                    : hasUserInteraction
                      ? "拓扑生成后在这里显示"
                      : "描述你的 TSN 需求后生成拓扑图"}
                </div>
              )}
            </div>
          </div>

          <div className="config-panel">
            <div className="config-tabs" role="tablist" aria-label="工程详情">
              {CONFIG_TABS.map((tab) => (
                <button
                  className={activeConfigTab === tab.id ? "config-tab active" : "config-tab"}
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeConfigTab === tab.id}
                  aria-controls={`config-panel-${tab.id}`}
                  id={`config-tab-${tab.id}`}
                  onClick={() => setActiveConfigTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
              <div className="config-spacer" />
              <span className="config-state mono">配置 · {project ? "草案" : "未生成"}</span>
            </div>

            <div className="config-body">
              {activeConfigTab === "flows" && (
                <section
                  className="flow-panel"
                  id="config-panel-flows"
                  role="tabpanel"
                  aria-label="流量列表"
                >
                  <div className="panel-heading">
                    <div>
                      <h2>流量规划</h2>
                      <p>记录当前 TSN 流、路径和关键时延参数，用于生成后续仿真输入。</p>
                    </div>
                    {selectedFlow && (
                      <button className="btn" type="button" onClick={() => setSelectedFlowId(undefined)}>
                        清除高亮
                      </button>
                    )}
                  </div>
                  <table className="eng-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Path</th>
                        <th>Period</th>
                        <th>Size</th>
                        <th>PCP</th>
                        <th>Deadline</th>
                        <th>Jitter</th>
                        <th>UDP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleFlows.length > 0 ? (
                        visibleFlows.map((flow) => (
                          <tr
                            aria-selected={flow.id === selectedFlowId}
                            className={flow.id === selectedFlowId ? "flow-row selected" : "flow-row"}
                            data-testid={`flow-row-${flow.id}`}
                            key={flow.id}
                            onClick={() => handleFlowSelect(flow.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleFlowSelect(flow.id);
                              }
                            }}
                            tabIndex={0}
                            title="点击后在拓扑图中高亮该流的路径"
                          >
                            <td>{flow.name}</td>
                            <td>{flow.routeNodeIds.join(" -> ")}</td>
                            <td>{flow.periodUs} us</td>
                            <td>{flow.frameSizeBytes} B</td>
                            <td>{flow.pcp}</td>
                            <td>{flow.latencyRequirementUs} us</td>
                            <td>{flow.jitterRequirementUs} us</td>
                            <td>{`${flow.source.udpPort} -> ${flow.destination.udpPort}`}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={8}>等待 Agent 生成流量规划</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>
              )}

              {activeConfigTab === "node-detail" && (
                <section
                  className="detail-panel"
                  id="config-panel-node-detail"
                  role="tabpanel"
                  aria-label="节点详情"
                >
                <div className="panel-heading">
                  <div>
                    <h2>节点详情</h2>
                    <p>{selectedNode ? selectedNode.name : "在拓扑画布选择一个节点查看端口、地址和位置。"}</p>
                  </div>
                </div>
                {selectedNode ? (
                  <div className="detail-grid">
                    <DetailRow label="节点 ID" value={selectedNode.id} />
                    <DetailRow label="名称" value={selectedNode.name} />
                    <DetailRow label="类型" value={selectedNode.type === "switch" ? "交换机" : "端系统"} />
                    <DetailRow label="数字 ID" value={selectedNode.numericId} />
                    <DetailRow label="端口数" value={selectedNode.ports.length} />
                    <DetailRow label="IP 地址" value={selectedNode.ipAddress ?? "无"} />
                    <DetailRow label="MAC 地址" value={selectedNode.macAddress ?? "无"} />
                    <DetailRow label="坐标" value={`${selectedNode.position.x}, ${selectedNode.position.y}`} />
                    <DetailRow label="规划节点类型" value={selectedNode.type === "switch" ? "0" : "1"} />
                    <DetailRow label="system_clock" value={PLANNER_NODE_PARAMETER_DEFAULTS.system_clock} />
                    <DetailRow label="qci_enable" value={PLANNER_NODE_PARAMETER_DEFAULTS.qci_enable} />
                    <DetailRow label="qbv_or_qch" value={PLANNER_NODE_PARAMETER_DEFAULTS.qbv_or_qch} />
                  </div>
                ) : (
                  <div className="empty-panel mono">请选择拓扑画布中的节点</div>
                )}
              </section>
              )}

              {activeConfigTab === "link-detail" && (
                <section
                  className="detail-panel"
                  id="config-panel-link-detail"
                  role="tabpanel"
                  aria-label="链路详情"
                >
                <div className="panel-heading">
                  <div>
                    <h2>链路详情</h2>
                    <p>{selectedLink ? selectedLink.id : "在拓扑画布选择一条链路查看端点、端口和速率。"}</p>
                  </div>
                </div>
                {selectedLink ? (
                  <div className="detail-grid">
                    <DetailRow label="链路 ID" value={selectedLink.id} />
                    <DetailRow label="数字 ID" value={selectedLink.numericId} />
                    <DetailRow
                      label="源端点"
                      value={`${selectedLinkSourceNode?.name ?? selectedLink.source.nodeId} / ${selectedLink.source.portId}`}
                    />
                    <DetailRow
                      label="目标端点"
                      value={`${selectedLinkTargetNode?.name ?? selectedLink.target.nodeId} / ${selectedLink.target.portId}`}
                    />
                    <DetailRow label="介质" value={selectedLink.medium} />
                    <DetailRow label="速率" value={`${selectedLink.dataRateMbps} Mbps`} />
                    <DetailRow
                      label="源规划端口"
                      value={selectedLinkSourceNode ? findPortIndex(selectedLinkSourceNode, selectedLink.source.portId) : "无"}
                    />
                    <DetailRow
                      label="目标规划端口"
                      value={selectedLinkTargetNode ? findPortIndex(selectedLinkTargetNode, selectedLink.target.portId) : "无"}
                    />
                    <DetailRow label="st_queues" value={PLANNER_LINK_DEFAULTS.st_queues} />
                    <DetailRow label="macrotick" value={PLANNER_LINK_DEFAULTS.macrotick} />
                  </div>
                ) : (
                  <div className="empty-panel mono">请选择拓扑画布中的链路</div>
                )}
              </section>
              )}

              {activeConfigTab === "artifacts" && (
                <section
                  className="artifact-panel"
                  id="config-panel-artifacts"
                  role="tabpanel"
                  aria-label="导出文件列表"
                >
                <div className="panel-heading inline">
                  <div>
                    <h2>项目导出文件</h2>
                    <p>按用途分组的工作台数据、规划器输入和 INET 仿真输入；当前不会执行 OMNeT++。</p>
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
                <PlannerTaskPanel
                  plannerRun={plannerRun}
                  baseUrl={plannerBaseUrl}
                  canStart={canStartPlanner}
                  canStop={canStopPlanner}
                  isActionRunning={isPlannerActionRunning}
                  onBaseUrlChange={setPlannerBaseUrl}
                  onStart={handleStartPlanner}
                  onStop={handleStopPlanner}
                />
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
                  {artifactGroups.map((group) => (
                    <section className="artifact-group" key={group.id} aria-label={group.label}>
                      <div className="artifact-group-heading">
                        <span>{group.label}</span>
                        <small>{group.items.length} 个文件</small>
                      </div>
                      {group.items.map(({ artifact, classification }) => (
                        <article className="artifact-item" key={artifact.path}>
                          <FileText size={15} aria-hidden="true" />
                          <div>
                            <span>{artifact.path}</span>
                            <p>
                              {artifact.label ?? artifact.purpose}
                              <strong>{classification.roleLabel}</strong>
                              {classification.isEntrypoint && <em>入口</em>}
                              {artifact.observedExternal && <em>外部观测</em>}
                            </p>
                          </div>
                        </article>
                      ))}
                    </section>
                  ))}
                  {!bundle && <div className="empty-panel mono">完成“模拟仿真”阶段后显示项目导出文件</div>}
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
              )}

            </div>
          </div>
        </section>
      </main>
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



function PlannerTaskPanel({
  plannerRun,
  baseUrl,
  canStart,
  canStop,
  isActionRunning,
  onBaseUrlChange,
  onStart,
  onStop,
}: {
  plannerRun: PlannerRunState;
  baseUrl: string;
  canStart: boolean;
  canStop: boolean;
  isActionRunning: boolean;
  onBaseUrlChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const statusLabel = plannerStatusLabel(plannerRun.status);
  const elapsed = plannerRun.runningDurationMs === undefined
    ? undefined
    : `${Math.max(0, Math.round(plannerRun.runningDurationMs / 1000))} 秒`;

  return (
    <section className={`planner-task-panel ${plannerRun.status}`} aria-label="规划任务">
      <div className="planner-task-header">
        <div>
          <h3>规划任务</h3>
          <p>启动后会提交当前拓扑、流和规划默认参数，并持续等待规划服务返回结果。</p>
        </div>
        <span className={`planner-status ${plannerRun.status}`}>{statusLabel}</span>
      </div>
      <div className="planner-task-controls">
        <label htmlFor="planner-base-url">服务地址</label>
        <input
          id="planner-base-url"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          disabled={plannerRun.status === "running" || isActionRunning}
        />
        <button className="btn-primary" type="button" onClick={onStart} disabled={!canStart}>
          <RefreshCw size={14} aria-hidden="true" />
          启动规划
        </button>
        <button className="btn" type="button" onClick={onStop} disabled={!canStop}>
          <Square size={13} aria-hidden="true" />
          停止
        </button>
      </div>
      <div className="planner-task-grid">
        <DetailRow label="任务 ID" value={plannerRun.planId ?? "未提交"} />
        <DetailRow label="节点/链路/流" value={plannerRun.requestSummary
          ? `${plannerRun.requestSummary.nodeCount}/${plannerRun.requestSummary.linkCount}/${plannerRun.requestSummary.flowCount}`
          : "未生成"} />
        <DetailRow label="运行时长" value={elapsed ?? "未开始"} />
        <DetailRow label="最近更新" value={plannerRun.updatedAt ? formatTime(plannerRun.updatedAt) : "无"} />
      </div>
      {plannerRun.resultSummary && (
        <div className="planner-result-summary" role="status">
          <span>结果摘要</span>
          <strong>{plannerRun.resultSummary.linkCount} 条链路 · {plannerRun.resultSummary.gclEntryCount} 条 GCL</strong>
          <p>{plannerRun.resultSummary.fingerprintFiles.join(", ") || "无指纹文件"}</p>
        </div>
      )}
      {plannerRun.errorMessage && (
        <p className="planner-error" role="alert">
          {plannerRun.errorMessage}
        </p>
      )}
    </section>
  );
}

function plannerStatusLabel(status: PlannerTaskState): string {
  const labels: Record<PlannerTaskState, string> = {
    idle: "未提交",
    running: "运行中",
    succeeded: "已完成",
    failed: "失败",
    busy: "服务忙",
    cancel_requested: "取消中",
    cancelled: "已取消",
    no_running_plan: "无运行任务",
    not_found: "未找到",
    stale: "已失效",
    unknown: "未知",
  };

  return labels[status];
}



function findPortIndex(node: { ports: Array<{ id: string; index: number }> }, portId: string): string | number {
  return node.ports.find((port) => port.id === portId)?.index ?? "无";
}

function groupArtifacts(artifacts: ExportedArtifact[]) {
  const grouped = new Map<ArtifactGroupId, Array<{ artifact: ExportedArtifact; classification: ArtifactClassification }>>();

  for (const artifact of artifacts) {
    const classification = classifyArtifact(artifact);
    const artifactsForGroup = grouped.get(classification.group) ?? [];
    artifactsForGroup.push({ artifact, classification });
    grouped.set(classification.group, artifactsForGroup);
  }

  return ARTIFACT_GROUP_ORDER
    .map((groupId) => {
      const items = grouped.get(groupId) ?? [];

      return {
        id: groupId,
        label: items[0]?.classification.groupLabel ?? artifactGroupFallbackLabels[groupId],
        items,
      };
    })
    .filter((group) => group.items.length > 0);
}

const artifactGroupFallbackLabels: Record<ArtifactGroupId, string> = {
  workspace: "工作台展示",
  planner: "外部规划器",
  "simulation-inet": "INET 仿真输入",
  manifest: "清单",
  legacy: "旧版文件",
};

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}


