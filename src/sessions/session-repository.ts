import type { AgentEvent, AgentStepDetail } from "../agent/agent-types";
import { CURRENT_SESSION_RUNTIME_VERSION, type SessionMetadata } from "../agent/agent-types";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { ArtifactBundle } from "../export/artifact-bundle";
import { normalizePlannerRunState, type PlannerRunState } from "../planner/planner-contract";
import { normalizeWorkflowState, type WorkflowState } from "../project/project-state";
import { repairSessionTopologyFromMessages } from "./session-topology-repair";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "tsn-agent.sessions.v0";
const CURRENT_SESSION_KEY = "tsn-agent.current-session.v0";
const MAX_RECENT_SESSIONS = 12;

export interface ChatMessageCta {
  label: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
  cta?: ChatMessageCta;
}

export interface TsnSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  claudeSessionId?: string;
  agentEvents: AgentEvent[];
  agentStepDetails?: Record<string, AgentStepDetail>;
  workflow: WorkflowState;
  plannerRun?: PlannerRunState;
  project?: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
  metadata?: SessionMetadata;
}

export interface SessionRepository {
  list(): Promise<TsnSession[]>;
  getCurrent(): Promise<TsnSession | undefined>;
  ensureCurrentSession(): Promise<TsnSession>;
  save(session: TsnSession): Promise<void>;
  setCurrent(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  duplicate(sessionId: string): Promise<TsnSession | undefined>;
}

export interface SessionDatabase {
  list(): Promise<StoredSession[]>;
  getCurrent(): Promise<StoredSession | undefined>;
  save(session: StoredSession): Promise<void>;
  setCurrent(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  eventCount: number;
  hasProject: boolean;
  projectName?: string;
  bundleFileCount: number;
  payload: string;
}

export class BrowserSessionRepository implements SessionRepository {
  constructor(private readonly storage: Storage) {}

  async list(): Promise<TsnSession[]> {
    return this.readSessions();
  }

  async getCurrent(): Promise<TsnSession | undefined> {
    const sessions = this.readSessions();
    const currentId = this.storage.getItem(CURRENT_SESSION_KEY);

    return sessions.find((session) => session.id === currentId) ?? sessions[0];
  }

  async ensureCurrentSession(): Promise<TsnSession> {
    const current = await this.getCurrent();

    if (current) {
      return current;
    }

    const session = createEmptySession();
    await this.save(session);
    return session;
  }

  async save(session: TsnSession): Promise<void> {
    const sessions = this.readSessions().filter((candidate) => candidate.id !== session.id);
    this.writeSessions([redactSessionForStorage(session), ...sessions].slice(0, MAX_RECENT_SESSIONS));
    this.storage.setItem(CURRENT_SESSION_KEY, session.id);
  }

  async setCurrent(sessionId: string): Promise<void> {
    const exists = this.readSessions().some((session) => session.id === sessionId);

    if (exists) {
      this.storage.setItem(CURRENT_SESSION_KEY, sessionId);
    }
  }

  async remove(sessionId: string): Promise<void> {
    const sessions = this.readSessions().filter((session) => session.id !== sessionId);
    this.writeSessions(sessions);

    if (this.storage.getItem(CURRENT_SESSION_KEY) === sessionId) {
      const nextSession = sessions[0];

      if (nextSession) {
        this.storage.setItem(CURRENT_SESSION_KEY, nextSession.id);
      } else {
        this.storage.removeItem(CURRENT_SESSION_KEY);
      }
    }
  }

  async duplicate(sessionId: string): Promise<TsnSession | undefined> {
    const original = this.readSessions().find((session) => session.id === sessionId);

    if (!original) {
      return undefined;
    }

    const copy = copySession(original);
    await this.save(copy);
    return copy;
  }

  private readSessions(): TsnSession[] {
    const raw = this.storage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as TsnSession[];
      return sortSessions(parsed.map(normalizeSession)).slice(0, MAX_RECENT_SESSIONS);
    } catch {
      return [];
    }
  }

  private writeSessions(sessions: TsnSession[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(sortSessions(sessions).slice(0, MAX_RECENT_SESSIONS)));
  }
}

export class SqliteSessionRepository implements SessionRepository {
  private readonly database: Promise<SessionDatabase>;

  constructor(database: Promise<SessionDatabase>) {
    this.database = database;
  }

  async list(): Promise<TsnSession[]> {
    const database = await this.getDatabase();
    const rows = await database.list();
    return rows.map(storedSessionToSession).filter(isSession);
  }

  async getCurrent(): Promise<TsnSession | undefined> {
    const database = await this.getDatabase();
    return storedSessionToSession(await database.getCurrent());
  }

  async ensureCurrentSession(): Promise<TsnSession> {
    const current = await this.getCurrent();

    if (current) {
      return current;
    }

    const session = createEmptySession();
    await this.save(session);
    return session;
  }

  async save(session: TsnSession): Promise<void> {
    const database = await this.getDatabase();
    const storedSession = redactSessionForStorage(session);

    await database.save(sessionToStoredSession(storedSession));
  }

  async setCurrent(sessionId: string): Promise<void> {
    const database = await this.getDatabase();
    await database.setCurrent(sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    const database = await this.getDatabase();
    await database.remove(sessionId);
  }

  async duplicate(sessionId: string): Promise<TsnSession | undefined> {
    const original = (await this.list()).find((session) => session.id === sessionId);

    if (!original) {
      return undefined;
    }

    const copy = copySession(original);
    await this.save(copy);
    return copy;
  }

  private getDatabase(): Promise<SessionDatabase> {
    return this.database;
  }
}

export function createSessionRepository(): SessionRepository {
  if (isTauriRuntime()) {
    return new SqliteSessionRepository(Promise.resolve(new TauriSessionDatabase()));
  }

  if (typeof window !== "undefined" && window.localStorage) {
    return new BrowserSessionRepository(window.localStorage);
  }

  return new BrowserSessionRepository(createMemoryStorage());
}

export function createEmptySession(): TsnSession {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    title: "新的 TSN 规划",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: createId("message"),
        role: "assistant",
        createdAt: now,
        content: "告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、时间同步、流量规划和模拟仿真准备。",
      },
    ],
    agentEvents: [],
    workflow: normalizeWorkflowState(),
    plannerRun: normalizePlannerRunState(),
    metadata: { runtimeVersion: CURRENT_SESSION_RUNTIME_VERSION },
  };
}

export function createId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `${prefix}-${random}`;
}

export function redactSessionForStorage(session: TsnSession): TsnSession {
  return {
    ...session,
    title: redactSecrets(session.title),
    messages: session.messages.map((message) => ({
      ...message,
      content: redactSecrets(message.content),
    })),
    agentEvents: session.agentEvents.map((event) => ({
      ...event,
      content: redactSecrets(event.content),
    })),
    agentStepDetails: session.agentStepDetails,
    workflow: normalizeWorkflowState(session.workflow),
    plannerRun: normalizePlannerRunState(session.plannerRun),
  };
}

function copySession(original: TsnSession): TsnSession {
  const now = new Date().toISOString();
  return {
    ...original,
    id: createId("session"),
    title: `${original.title} 副本`,
    createdAt: now,
    updatedAt: now,
    claudeSessionId: undefined,
  };
}

function storedSessionToSession(session: StoredSession | undefined): TsnSession | undefined {
  if (!session) {
    return undefined;
  }

  try {
    return normalizeSession(JSON.parse(session.payload) as TsnSession);
  } catch {
    return undefined;
  }
}

function normalizeSession(session: TsnSession): TsnSession {
  const normalizedEvents = (session.agentEvents ?? []).map(migrateOrphanPendingStep);
  const incomingMetadata = session.metadata ?? {};
  const hadRuntimeVersion = typeof incomingMetadata.runtimeVersion === "number";
  const hasHistoricalContent = normalizedEvents.length > 0 || (session.messages ?? []).length > 1;
  const isLegacyOrigin =
    !hadRuntimeVersion && hasHistoricalContent ? true : incomingMetadata.legacyFakeOrigin;
  const metadata: SessionMetadata = {
    ...incomingMetadata,
    runtimeVersion: CURRENT_SESSION_RUNTIME_VERSION,
    ...(isLegacyOrigin ? { legacyFakeOrigin: true } : {}),
  };

  const cleanedMessages = (session.messages ?? []).map(stripLegacyTraceLinesFromMessage);

  const base: TsnSession = {
    ...session,
    messages: cleanedMessages,
    agentEvents: normalizedEvents,
    workflow: normalizeWorkflowState(session.workflow),
    plannerRun: normalizePlannerRunState(session.plannerRun),
    metadata,
  };
  if (session.agentStepDetails) {
    base.agentStepDetails = session.agentStepDetails;
  }
  return repairSessionTopologyFromMessages(base);
}

const LEGACY_TRACE_LINE_PATTERN = /^\s*\[(?:工具|工具结果|文件|Skill)\][^\n]*$/;

function stripLegacyTraceLinesFromMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }
  const original = message.content ?? "";
  if (!LEGACY_TRACE_LINE_PATTERN.test(original) && !original.includes("[工具]") && !original.includes("[工具结果]") && !original.includes("[文件]") && !original.includes("[Skill]")) {
    return message;
  }
  const cleaned = original
    .split("\n")
    .filter((line) => !LEGACY_TRACE_LINE_PATTERN.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned === original.trim()) {
    return message;
  }
  return { ...message, content: cleaned };
}

function migrateOrphanPendingStep(event: AgentEvent): AgentEvent {
  if (event.status === "pending" || event.status === "streaming") {
    return { ...event, status: "unknown" };
  }
  return event;
}

function isSession(session: TsnSession | undefined): session is TsnSession {
  return Boolean(session);
}

function sortSessions(sessions: TsnSession[]): TsnSession[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(sk-ant-[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|claude_api_key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/("(?:accessToken|refreshToken|authToken|apiKey|api_key|token|secret|password)"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi, "$1[redacted]");
}

function sessionToStoredSession(session: TsnSession): StoredSession {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    hasProject: Boolean(session.project),
    projectName: session.project?.name,
    bundleFileCount: session.bundle?.artifacts.length ?? 0,
    payload: JSON.stringify(session),
  };
}

export { CURRENT_SESSION_RUNTIME_VERSION };
export type { SessionMetadata } from "../agent/agent-types";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

class TauriSessionDatabase implements SessionDatabase {
  async list(): Promise<StoredSession[]> {
    return invoke<StoredSession[]>("list_sessions");
  }

  async getCurrent(): Promise<StoredSession | undefined> {
    const session = await invoke<StoredSession | null>("get_current_session");
    return session ?? undefined;
  }

  async save(session: StoredSession): Promise<void> {
    await invoke("save_session", {
      request: {
        session,
      },
    });
  }

  async setCurrent(sessionId: string): Promise<void> {
    await invoke("set_current_session", {
      request: {
        sessionId,
      },
    });
  }

  async remove(sessionId: string): Promise<void> {
    await invoke("remove_session", {
      request: {
        sessionId,
      },
    });
  }
}
