import { invoke } from "@tauri-apps/api/core";
import {
  createDiagnosticLogEntry,
  type DiagnosticLogEntry,
  type DiagnosticLogInput,
  sanitizeDiagnosticLogEntry,
} from "./diagnostic-log";

const STORAGE_KEY = "tsn-agent.diagnostic-logs.v0";
const MAX_LOGS_PER_SESSION = 300;

export interface DiagnosticLogRepository {
  append(input: DiagnosticLogInput | DiagnosticLogEntry): Promise<void>;
  list(sessionId: string): Promise<DiagnosticLogEntry[]>;
  clearSession(sessionId: string): Promise<void>;
}

export class BrowserDiagnosticLogRepository implements DiagnosticLogRepository {
  constructor(private readonly storage: Storage = createMemoryStorage()) {}

  async append(input: DiagnosticLogInput | DiagnosticLogEntry): Promise<void> {
    try {
      const entry = normalizeDiagnosticInput(input);
      const logs = this.readLogs().filter((candidate) => candidate.id !== entry.id);
      const nextLogs = trimLogsForSession([entry, ...logs], entry.sessionId);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(sortLogs(nextLogs)));
    } catch (error) {
      console.warn("diagnostic log append failed", error);
    }
  }

  async list(sessionId: string): Promise<DiagnosticLogEntry[]> {
    return this.readLogs()
      .filter((entry) => entry.sessionId === sessionId)
      .slice(0, MAX_LOGS_PER_SESSION);
  }

  async clearSession(sessionId: string): Promise<void> {
    try {
      const logs = this.readLogs().filter((entry) => entry.sessionId !== sessionId);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(logs));
    } catch (error) {
      console.warn("diagnostic log clear failed", error);
    }
  }

  private readLogs(): DiagnosticLogEntry[] {
    const raw = this.storage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    try {
      return sortLogs((JSON.parse(raw) as DiagnosticLogEntry[]).map(sanitizeDiagnosticLogEntry));
    } catch {
      return [];
    }
  }
}

export class TauriDiagnosticLogRepository implements DiagnosticLogRepository {
  async append(input: DiagnosticLogInput | DiagnosticLogEntry): Promise<void> {
    try {
      await invoke("append_diagnostic_log", {
        request: {
          entry: normalizeDiagnosticInput(input),
        },
      });
    } catch (error) {
      console.warn("diagnostic log append failed", error);
    }
  }

  async list(sessionId: string): Promise<DiagnosticLogEntry[]> {
    return invoke<DiagnosticLogEntry[]>("list_diagnostic_logs", {
      request: {
        sessionId,
        limit: MAX_LOGS_PER_SESSION,
      },
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    try {
      await invoke("clear_session_diagnostic_logs", {
        request: {
          sessionId,
        },
      });
    } catch (error) {
      console.warn("diagnostic log clear failed", error);
    }
  }
}

export function createDiagnosticLogRepository(): DiagnosticLogRepository {
  if (isTauriRuntime()) {
    return new TauriDiagnosticLogRepository();
  }

  if (typeof window !== "undefined" && window.localStorage) {
    return new BrowserDiagnosticLogRepository(window.localStorage);
  }

  return new BrowserDiagnosticLogRepository(createMemoryStorage());
}

export function normalizeDiagnosticInput(
  input: DiagnosticLogInput | DiagnosticLogEntry,
): DiagnosticLogEntry {
  if ("id" in input && "createdAt" in input) {
    return sanitizeDiagnosticLogEntry(input);
  }

  return createDiagnosticLogEntry(input);
}

function trimLogsForSession(logs: DiagnosticLogEntry[], sessionId: string): DiagnosticLogEntry[] {
  const sessionLogs = sortLogs(logs.filter((entry) => entry.sessionId === sessionId)).slice(
    0,
    MAX_LOGS_PER_SESSION,
  );
  const otherLogs = logs.filter((entry) => entry.sessionId !== sessionId);

  return [...sessionLogs, ...otherLogs];
}

function sortLogs(logs: DiagnosticLogEntry[]): DiagnosticLogEntry[] {
  return [...logs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

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
