import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectExport } from "./use-project-export";
import { createEmptySession, type TsnSession } from "../../sessions/session-repository";
import { BrowserDiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";

type PersistSessionFn = (next: TsnSession, options?: { logCategory?: "artifact" | "session" | "agent"; logMessage?: string; logDetails?: Record<string, unknown> }) => Promise<void>;

vi.mock("../../workflow/project-exporter", () => ({
  exportProjectBundle: vi.fn(),
  selectProjectExportDirectory: vi.fn(),
  openProjectExportDirectory: vi.fn(),
  suggestProjectExportDirectory: vi.fn(() => Promise.resolve(undefined)),
}));

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

describe("useProjectExport", () => {
  let diagnostics: BrowserDiagnosticLogRepository;
  let persistSessionMock: PersistSessionFn & { mock?: unknown };
  let session: TsnSession;

  beforeEach(() => {
    diagnostics = new BrowserDiagnosticLogRepository(createMemoryStorage());
    persistSessionMock = vi.fn(async () => undefined) as unknown as PersistSessionFn & { mock?: unknown };
    session = createEmptySession();
  });

  it("initializes with empty export directory and undefined result/error", async () => {
    const { result } = renderHook(() =>
      useProjectExport({
        currentSession: session,
        diagnostics,
        persistSession: persistSessionMock,
        plannerResultForCurrentProject: undefined,
      }),
    );
    await waitFor(() => {
      expect(result.current.exportDirectory).toBe("");
    });
    expect(result.current.exportResult).toBeUndefined();
    expect(result.current.exportError).toBeUndefined();
  });

  it("canExport is false when no bundle / wrong workflow stage", async () => {
    const { result } = renderHook(() =>
      useProjectExport({
        currentSession: session,
        diagnostics,
        persistSession: persistSessionMock,
        plannerResultForCurrentProject: undefined,
      }),
    );
    expect(result.current.canExport).toBe(false);
    expect(result.current.canRefreshBundle).toBe(false);
  });

  it("setExportDirectory updates the directory string", async () => {
    const { result } = renderHook(() =>
      useProjectExport({
        currentSession: session,
        diagnostics,
        persistSession: persistSessionMock,
        plannerResultForCurrentProject: undefined,
      }),
    );
    act(() => {
      result.current.setExportDirectory("/path/to/dir");
    });
    expect(result.current.exportDirectory).toBe("/path/to/dir");
  });

  it("clears export state when currentSession.id changes", async () => {
    const { result, rerender } = renderHook(
      ({ s }: { s: TsnSession }) =>
        useProjectExport({
          currentSession: s,
          diagnostics,
          persistSession: persistSessionMock,
          plannerResultForCurrentProject: undefined,
        }),
      { initialProps: { s: session } },
    );
    act(() => {
      result.current.setExportDirectory("/old");
    });
    expect(result.current.exportDirectory).toBe("/old");

    const newSession = createEmptySession();
    rerender({ s: newSession });
    await waitFor(() => {
      expect(result.current.exportDirectory).toBe("");
    });
  });
});
