import type { AgentEvent } from "../agent/fake-agent";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { ArtifactBundle } from "../export/artifact-bundle";

const STORAGE_KEY = "tsn-agent.sessions.v0";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface TsnSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  agentEvents: AgentEvent[];
  project?: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
}

export interface SessionRepository {
  list(): TsnSession[];
  save(session: TsnSession): void;
  remove(sessionId: string): void;
  duplicate(sessionId: string): TsnSession | undefined;
}

export class LocalStorageSessionRepository implements SessionRepository {
  constructor(private readonly storage: Storage) {}

  list(): TsnSession[] {
    const raw = this.storage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as TsnSession[];
      return parsed.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch {
      return [];
    }
  }

  save(session: TsnSession): void {
    const sessions = this.list().filter((candidate) => candidate.id !== session.id);
    this.write([session, ...sessions].slice(0, 12));
  }

  remove(sessionId: string): void {
    this.write(this.list().filter((session) => session.id !== sessionId));
  }

  duplicate(sessionId: string): TsnSession | undefined {
    const original = this.list().find((session) => session.id === sessionId);

    if (!original) {
      return undefined;
    }

    const now = new Date().toISOString();
    const copy: TsnSession = {
      ...original,
      id: createId("session"),
      title: `${original.title} 副本`,
      createdAt: now,
      updatedAt: now,
    };
    this.save(copy);
    return copy;
  }

  private write(sessions: TsnSession[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }
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
        content: "告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、流模板和导出文件。",
      },
    ],
    agentEvents: [],
  };
}

export function createId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `${prefix}-${random}`;
}
