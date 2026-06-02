import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundleForAgentResult,
  createPlannerRunToken,
  plannerRunForAgentResult,
  usePlannerRun,
} from "./use-planner-run";
import { createProjectFromIntent } from "../../topology/topology-factory";
import { createArtifactBundle } from "../../export/artifact-bundle";
import {
  createPlannerRequestFingerprint,
  type PlannerRunState,
} from "../../planner/planner-contract";
import { exportPlannerInput } from "../../export/planner-exporter";
import {
  BrowserSessionRepository,
  createEmptySession,
  type SessionRepository,
  type TsnSession,
} from "../../sessions/session-repository";
import { BrowserDiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";
import { confirmCurrentStage, normalizeWorkflowState, recordStageResult } from "../../workflow/project-state";

vi.mock("../../planner/planner-client", () => ({
  startPlannerPlan: vi.fn(),
  stopPlannerPlan: vi.fn(),
  queryPlannerPlanStatus: vi.fn(),
  getPlannerPlanResult: vi.fn(),
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

function createTestRepository(): SessionRepository {
  return new BrowserSessionRepository(createMemoryStorage());
}

function createTestDiagnostics(): BrowserDiagnosticLogRepository {
  return new BrowserDiagnosticLogRepository(createMemoryStorage());
}

function planningReadySession(): TsnSession {
  const session = createEmptySession();
  session.project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
  const topology = confirmCurrentStage(
    recordStageResult(normalizeWorkflowState(), {
      step: "topology",
      summary: "ok",
      waitingConfirmation: true,
    }),
  );
  const sync = confirmCurrentStage(
    recordStageResult(topology, {
      step: "time-sync",
      summary: "ok",
      waitingConfirmation: true,
    }),
  );
  const flow = confirmCurrentStage(
    recordStageResult(sync, {
      step: "flow-template",
      summary: "ok",
      waitingConfirmation: true,
    }),
  );
  session.workflow = recordStageResult(flow, {
    step: "planning-export",
    summary: "ok",
    waitingConfirmation: true,
  });
  return session;
}

describe("usePlannerRun hook integration", () => {
  let repository: SessionRepository;
  let diagnostics: BrowserDiagnosticLogRepository;
  // vi.fn cast to the exact callback signatures the hook expects
  type OnPersisted = ((next: TsnSession) => void) & { mock: { calls: TsnSession[][] } };
  type OnStart = (() => void) & { mock: { calls: unknown[][] } };
  let onPersistedSession: OnPersisted;
  let onPlannerStart: OnStart;
  let plannerClient: typeof import("../../planner/planner-client");

  beforeEach(async () => {
    repository = createTestRepository();
    diagnostics = createTestDiagnostics();
    onPersistedSession = vi.fn() as unknown as OnPersisted;
    onPlannerStart = vi.fn() as unknown as OnStart;
    plannerClient = await import("../../planner/planner-client");
    vi.mocked(plannerClient.startPlannerPlan).mockReset();
    vi.mocked(plannerClient.stopPlannerPlan).mockReset();
    vi.mocked(plannerClient.queryPlannerPlanStatus).mockReset();
    vi.mocked(plannerClient.getPlannerPlanResult).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initial state: idle planner + canStart=false when no project", () => {
    const session = createEmptySession();
    const { result } = renderHook(() =>
      usePlannerRun({
        currentSession: session,
        repository,
        diagnostics,
        onPersistedSession,
      }),
    );
    expect(result.current.plannerRun.status).toBe("idle");
    expect(result.current.canStartPlanner).toBe(false);
    expect(result.current.canStopPlanner).toBe(false);
  });

  it("canStartPlanner=true when project + planning-export waiting + planner idle", () => {
    const session = planningReadySession();
    const { result } = renderHook(() =>
      usePlannerRun({
        currentSession: session,
        repository,
        diagnostics,
        onPersistedSession,
      }),
    );
    expect(result.current.canStartPlanner).toBe(true);
  });

  it("handleStartPlanner submits + invokes onPlannerStart + onPersistedSession", async () => {
    const session = planningReadySession();
    await repository.save(session);

    vi.mocked(plannerClient.startPlannerPlan).mockResolvedValue({
      err_code: 0,
      err_msg: "",
      data: { state: "running", plan_id: "plan-test-1", started_at: "2026-06-03T00:00:00Z" },
      timestamp: "2026-06-03T00:00:00Z",
    } as never);

    const { result } = renderHook(() =>
      usePlannerRun({
        currentSession: session,
        repository,
        diagnostics,
        onPersistedSession,
        onPlannerStart,
      }),
    );

    await act(async () => {
      await result.current.handleStartPlanner();
    });

    expect(onPlannerStart).toHaveBeenCalledTimes(1);
    expect(plannerClient.startPlannerPlan).toHaveBeenCalled();
    // Two persists occur: submitting + running
    expect(onPersistedSession).toHaveBeenCalled();
  });

  it("handleStartPlanner marks planner failed on startPlannerPlan rejection", async () => {
    const session = planningReadySession();
    await repository.save(session);

    vi.mocked(plannerClient.startPlannerPlan).mockRejectedValue(new Error("connect refused"));

    const { result } = renderHook(() =>
      usePlannerRun({
        currentSession: session,
        repository,
        diagnostics,
        onPersistedSession,
      }),
    );

    await act(async () => {
      await result.current.handleStartPlanner();
    });

    await waitFor(() => {
      expect(onPersistedSession).toHaveBeenCalled();
    });
    const lastCall = onPersistedSession.mock.calls.at(-1)?.[0] as TsnSession | undefined;
    expect(lastCall?.plannerRun?.status).toBe("failed");
    expect(lastCall?.plannerRun?.errorMessage).toMatch(/connect refused/);
  });

  it("isPlannerActionRunning transitions while a handler is in flight", async () => {
    const session = planningReadySession();
    await repository.save(session);

    let resolveStart: (value: never) => void = () => undefined;
    vi.mocked(plannerClient.startPlannerPlan).mockReturnValue(
      new Promise<never>((resolve) => {
        resolveStart = resolve as (value: never) => void;
      }),
    );

    const { result } = renderHook(() =>
      usePlannerRun({
        currentSession: session,
        repository,
        diagnostics,
        onPersistedSession,
      }),
    );

    expect(result.current.isPlannerActionRunning).toBe(false);
    let startPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      startPromise = result.current.handleStartPlanner();
      // give React time to flush the setIsPlannerActionRunning(true) state
      await Promise.resolve();
    });
    expect(result.current.isPlannerActionRunning).toBe(true);

    await act(async () => {
      resolveStart({
        err_code: 0,
        err_msg: "",
        data: { state: "running", plan_id: "plan-x" },
        timestamp: "2026-06-03T00:00:00Z",
      } as never);
      await startPromise;
    });
    expect(result.current.isPlannerActionRunning).toBe(false);
  });
});

describe("usePlannerRun helpers", () => {
  it("createPlannerRunToken returns a unique-ish string per call", () => {
    const a = createPlannerRunToken();
    const b = createPlannerRunToken();
    expect(a).toMatch(/^planner-run-/);
    expect(b).toMatch(/^planner-run-/);
    expect(a).not.toBe(b);
  });

  it("plannerRunForAgentResult keeps run when fingerprint matches new project", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
    const current: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: fingerprint,
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: fingerprint,
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = plannerRunForAgentResult(current, project);
    expect(result.status).toBe("succeeded");
    expect(result.requestFingerprint).toBe(fingerprint);
  });

  it("plannerRunForAgentResult marks stale when project changes", () => {
    const projectA = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const projectB = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");
    const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(projectA));
    const current: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: fingerprint,
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: fingerprint,
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = plannerRunForAgentResult(current, projectB);
    expect(result.status).toBe("stale");
  });

  it("plannerRunForAgentResult returns current unchanged if there's no snapshot to invalidate", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const current: PlannerRunState = { status: "idle", baseUrl: "" };
    const result = plannerRunForAgentResult(current, project);
    expect(result).toEqual(current);
  });

  it("bundleForAgentResult rebuilds bundle when fingerprint matches", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
    const bundle = createArtifactBundle(project);
    const run: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: fingerprint,
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: fingerprint,
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = bundleForAgentResult(project, bundle, run);
    expect(result).toBeDefined();
  });

  it("bundleForAgentResult returns original bundle when fingerprint mismatched", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const bundle = createArtifactBundle(project);
    const run: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: "different-fingerprint",
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: "different-fingerprint",
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = bundleForAgentResult(project, bundle, run);
    expect(result).toBe(bundle);
  });

  it("bundleForAgentResult returns input bundle unchanged when bundle is undefined", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const run: PlannerRunState = { status: "idle", baseUrl: "" };
    const result = bundleForAgentResult(project, undefined, run);
    expect(result).toBeUndefined();
  });
});
