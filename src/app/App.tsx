import { useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Copy, FileText, Plus, Send, Trash2 } from "lucide-react";
import { runFakeTsnAgent } from "../agent/fake-agent";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createArtifactBundle } from "../export/artifact-bundle";
import { exportReactFlowTopology } from "../export/react-flow-exporter";
import {
  createEmptySession,
  createId,
  LocalStorageSessionRepository,
  type ChatMessage,
  type TsnSession,
} from "../sessions/session-repository";

const repository = typeof window !== "undefined"
  ? new LocalStorageSessionRepository(window.localStorage)
  : undefined;

export function App() {
  const initialSession = useMemo(() => repository?.list()[0] ?? createEmptySession(), []);
  const [sessions, setSessions] = useState<TsnSession[]>(() => {
    const savedSessions = repository?.list() ?? [];
    return savedSessions.length > 0 ? savedSessions : [initialSession];
  });
  const [currentSession, setCurrentSession] = useState<TsnSession>(initialSession);
  const [input, setInput] = useState("我需要4个交换机，每个交换机连接5个端系统");

  const project = currentSession.project;
  const bundle = currentSession.bundle;
  const flowTopology = useMemo(() => (project ? exportReactFlowTopology(project) : undefined), [project]);
  const switchCount = project?.topology.nodes.filter(isSwitch).length ?? 0;
  const endSystemCount = project?.topology.nodes.filter(isEndSystem).length ?? 0;

  function persistSession(nextSession: TsnSession) {
    repository?.save(nextSession);
    setCurrentSession(nextSession);
    setSessions(repository?.list() ?? [nextSession]);
  }

  function handleSubmit() {
    const trimmedInput = input.trim();

    if (!trimmedInput) {
      return;
    }

    const result = runFakeTsnAgent(trimmedInput);
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
      content: result.events.map((event) => event.content).join("\n"),
    };
    const nextSession: TsnSession = {
      ...currentSession,
      title: result.project.name,
      updatedAt: now,
      messages: [...currentSession.messages, userMessage, assistantMessage],
      agentEvents: result.events,
      project: result.project,
      bundle: result.bundle,
    };

    persistSession(nextSession);
  }

  function handleNewSession() {
    const session = createEmptySession();
    persistSession(session);
  }

  function handleDuplicateSession() {
    const duplicated = repository?.duplicate(currentSession.id);

    if (duplicated) {
      setCurrentSession(duplicated);
      setSessions(repository?.list() ?? [duplicated]);
    }
  }

  function handleDeleteSession() {
    repository?.remove(currentSession.id);
    const nextSession = repository?.list()[0] ?? createEmptySession();
    repository?.save(nextSession);
    setCurrentSession(nextSession);
    setSessions(repository?.list() ?? [nextSession]);
  }

  function refreshBundle() {
    if (!project) {
      return;
    }

    persistSession({
      ...currentSession,
      updatedAt: new Date().toISOString(),
      bundle: createArtifactBundle(project),
    });
  }

  return (
    <main className="app-shell">
      <aside className="session-rail" aria-label="会话">
        <div className="brand-block">
          <p className="eyebrow">TSN Agent</p>
          <h1>规划工作台</h1>
        </div>

        <button className="primary-action" type="button" onClick={handleNewSession}>
          <Plus size={16} aria-hidden="true" />
          新会话
        </button>

        <div className="session-list" aria-label="最近会话">
          {sessions.map((session) => (
            <button
              className={session.id === currentSession.id ? "session-item active" : "session-item"}
              key={session.id}
              type="button"
              onClick={() => setCurrentSession(session)}
            >
              <span>{session.title}</span>
              <time>{formatTime(session.updatedAt)}</time>
            </button>
          ))}
        </div>

        <div className="rail-actions">
          <button type="button" onClick={handleDuplicateSession}>
            <Copy size={15} aria-hidden="true" />
            复制
          </button>
          <button type="button" onClick={handleDeleteSession}>
            <Trash2 size={15} aria-hidden="true" />
            删除
          </button>
        </div>
      </aside>

      <section className="conversation-panel" aria-label="对话区">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Agent 对话</p>
            <h2>从网络规模开始</h2>
          </div>
          <span className="status-pill">{project ? "已生成草案" : "等待输入"}</span>
        </div>

        <div className="messages" aria-live="polite">
          {currentSession.messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>{message.role === "user" ? "你" : "Agent"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>

        <div className="composer">
          <label htmlFor="intent">TSN 需求</label>
          <textarea
            id="intent"
            aria-label="输入你的 TSN 需求"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={4}
          />
          <button type="button" onClick={handleSubmit}>
            <Send size={16} aria-hidden="true" />
            生成规划草案
          </button>
        </div>
      </section>

      <section className="workspace-panel" aria-label="工程状态">
        <div className="summary-grid">
          <Metric label="交换机" value={switchCount} />
          <Metric label="端系统" value={endSystemCount} />
          <Metric label="链路" value={project?.topology.links.length ?? 0} />
          <Metric label="控制流" value={project?.flows.length ?? 0} />
        </div>

        <div className="workspace-section topology-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Topology</p>
              <h2>拓扑草案</h2>
            </div>
          </div>
          <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
            {flowTopology ? (
              <ReactFlow nodes={flowTopology.nodes} edges={flowTopology.edges} fitView nodesDraggable={false}>
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="empty-state">尚未生成拓扑</div>
            )}
          </div>
        </div>

        <div className="workspace-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Artifacts</p>
              <h2>导出文件</h2>
            </div>
            <button type="button" className="secondary-action" onClick={refreshBundle} disabled={!project}>
              <FileText size={15} aria-hidden="true" />
              刷新
            </button>
          </div>

          <div className="artifact-list" aria-label="导出文件列表">
            {(bundle?.artifacts ?? []).map((artifact) => (
              <article className="artifact-item" key={artifact.path}>
                <span>{artifact.path}</span>
                <p>{artifact.purpose}</p>
              </article>
            ))}
            {!bundle && <div className="empty-state compact">没有导出文件</div>}
          </div>
        </div>

        <div className="workspace-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Steps</p>
              <h2>执行步骤</h2>
            </div>
          </div>
          <ol className="event-list">
            {currentSession.agentEvents.map((event) => (
              <li key={event.id}>
                <span>{event.skillName ?? event.title}</span>
                <p>{event.content}</p>
              </li>
            ))}
            {currentSession.agentEvents.length === 0 && <li className="empty-step">等待 Agent 输出</li>}
          </ol>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>
        {label} {value}
      </strong>
    </div>
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
