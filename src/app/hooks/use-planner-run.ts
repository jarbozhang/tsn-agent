import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logDiagnostic, plannerRunSummary } from "../../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";
import { exportPlannerInput } from "../../export/planner-exporter";
import { createArtifactBundle } from "../../export/artifact-bundle";
import {
  getPlannerPlanResult,
  queryPlannerPlanStatus,
  startPlannerPlan,
  stopPlannerPlan,
} from "../../planner/planner-client";
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
} from "../../planner/planner-contract";
import type { SessionRepository, TsnSession } from "../../sessions/session-repository";

const PLANNER_POLL_INTERVAL_MS = import.meta.env.MODE === "test" ? 20 : 3000;
const PLANNER_TRANSIENT_FAILURE_RETRY_LIMIT = 2;

export interface UsePlannerRunOptions {
  currentSession: TsnSession;
  repository: SessionRepository;
  diagnostics: DiagnosticLogRepository;
  /** Called with the persisted session (already saved + diagnostic logged). */
  onPersistedSession: (next: TsnSession) => void;
  /** Optional UI side-effect on planner start (e.g. switch tab to artifacts). */
  onPlannerStart?: () => void;
}

export interface UsePlannerRunReturn {
  plannerRun: PlannerRunState;
  plannerBaseUrl: string;
  setPlannerBaseUrl: (value: string) => void;
  isPlannerActionRunning: boolean;
  canStartPlanner: boolean;
  canStopPlanner: boolean;
  currentPlannerRequestFingerprint: string | undefined;
  plannerResultForCurrentProject: PlannerRunState["resultSnapshot"];
  handleStartPlanner: () => Promise<void>;
  handleStopPlanner: () => Promise<void>;
}

export function usePlannerRun(options: UsePlannerRunOptions): UsePlannerRunReturn {
  const { currentSession, repository, diagnostics, onPersistedSession, onPlannerStart } = options;
  const project = currentSession.project;

  const plannerRun = useMemo(
    () => normalizePlannerRunState(currentSession.plannerRun),
    [currentSession.plannerRun],
  );
  const [plannerBaseUrl, setPlannerBaseUrl] = useState(() =>
    resolvePlannerBaseUrl(currentSession.plannerRun?.baseUrl),
  );
  const [isPlannerActionRunning, setIsPlannerActionRunning] = useState(false);
  const plannerPollTimeoutRef = useRef<number | undefined>(undefined);
  const plannerTransientFailureCountRef = useRef(0);

  const workflow = currentSession.workflow;
  const planningExportStatus = workflow.stages["planning-export"]?.status;
  const canStartPlanner = Boolean(
    project
      && workflow.currentStep === "planning-export"
      && (["current", "waiting_confirmation", "confirmed"] as const).includes(planningExportStatus as never)
      && !isPlannerActionRunning
      && plannerRun.status !== "running"
      && plannerRun.status !== "cancel_requested",
  );
  const canStopPlanner = Boolean(
    (plannerRun.status === "running" || plannerRun.status === "busy" || plannerRun.status === "cancel_requested")
      && !isPlannerActionRunning,
  );
  const currentPlannerRequestFingerprint = useMemo(() => {
    if (!project) {
      return undefined;
    }
    try {
      return createPlannerRequestFingerprint(exportPlannerInput(project));
    } catch {
      return undefined;
    }
  }, [project]);
  const plannerResultForCurrentProject = currentPlannerRequestFingerprint
    && plannerRun.resultSnapshot?.requestFingerprint === currentPlannerRequestFingerprint
    ? plannerRun.resultSnapshot
    : undefined;

  // Keep the textbox baseUrl in sync with the session's stored baseUrl.
  useEffect(() => {
    setPlannerBaseUrl(resolvePlannerBaseUrl(currentSession.plannerRun?.baseUrl));
  }, [currentSession.plannerRun?.baseUrl]);

  // Persist + log helper.
  const persistPlannerSession = useCallback(
    async (nextSession: TsnSession, message: string) => {
      await repository.save(nextSession);
      logDiagnostic(diagnostics, {
        sessionId: nextSession.id,
        category: "session",
        message,
        details: plannerRunSummary(nextSession),
      });
      onPersistedSession(nextSession);
    },
    [repository, diagnostics, onPersistedSession],
  );

  // Polling primitives.
  const clearPlannerPollTimeout = useCallback(() => {
    if (plannerPollTimeoutRef.current === undefined) {
      return;
    }
    window.clearTimeout(plannerPollTimeoutRef.current);
    plannerPollTimeoutRef.current = undefined;
  }, []);

  const attachPlannerResult = useCallback(
    async (session: TsnSession, baseUrl: string, planId: string, run: PlannerRunState): Promise<TsnSession> => {
      if (!session.project) {
        return session;
      }
      const resultResponse = await getPlannerPlanResult({ baseUrl, planId });
      assertSuccessfulPlannerResult(resultResponse, planId);
      const sourceOutputs = resultResponse.data.source_outputs ?? {};
      const outputFingerprints = resultResponse.data.output_fingerprints;
      const summary = summarizePlannerResult(sourceOutputs, outputFingerprints);
      const resultSnapshot = {
        planId,
        state: "succeeded" as const,
        requestFingerprint: run.requestFingerprint,
        sourceOutputs,
        outputFingerprints,
        traceId: resultResponse.trace_id,
        timestamp: resultResponse.timestamp,
        receivedAt: new Date().toISOString(),
        summary,
      };
      const plannerRunWithResult: PlannerRunState = {
        ...run,
        resultSummary: summary,
        resultSnapshot,
        traceId: resultResponse.trace_id ?? run.traceId,
        updatedAt: resultResponse.timestamp ?? run.updatedAt,
      };
      return {
        ...session,
        plannerRun: plannerRunWithResult,
        bundle: createArtifactBundle(session.project, { plannerResult: resultSnapshot }),
      };
    },
    [],
  );

  const pollPlanner = useCallback(
    async (sessionId: string, planId: string, baseUrl: string, runToken?: string) => {
      try {
        const latestSession = (await repository.list()).find((s) => s.id === sessionId);
        const latestRun = normalizePlannerRunState(latestSession?.plannerRun);
        if (!isExpectedPlannerRun(latestSession, planId, runToken)) {
          return;
        }
        const response = await queryPlannerPlanStatus({ baseUrl, planId });
        const nextRun = plannerRunFromQueryResponse(latestRun, response);
        let nextSession: TsnSession = {
          ...latestSession,
          updatedAt: new Date().toISOString(),
          plannerRun: nextRun,
        };
        if (!(await isLatestPlannerRun(repository, sessionId, planId, runToken))) {
          return;
        }
        if (nextRun.status === "succeeded") {
          nextSession = await attachPlannerResult(nextSession, baseUrl, planId, nextRun);
        }
        if (!(await isLatestPlannerRun(repository, sessionId, planId, runToken))) {
          return;
        }
        plannerTransientFailureCountRef.current = 0;
        await persistPlannerSession(nextSession, "规划任务状态已更新");
        if (!isTerminalPlannerState(nextRun.status)) {
          schedulePlannerPollInternal(sessionId, planId, baseUrl, nextRun.runToken);
        }
      } catch (error) {
        const latestSession = (await repository.list()).find((s) => s.id === sessionId);
        if (!isExpectedPlannerRun(latestSession, planId, runToken)) {
          return;
        }
        plannerTransientFailureCountRef.current += 1;
        const latestRun = normalizePlannerRunState(latestSession.plannerRun);
        const exhaustedRetries = plannerTransientFailureCountRef.current > PLANNER_TRANSIENT_FAILURE_RETRY_LIMIT;
        const nextRun: PlannerRunState = {
          ...latestRun,
          status: exhaustedRetries ? "failed" : latestRun.status,
          updatedAt: new Date().toISOString(),
          errorMessage: normalizeError(error),
        };
        await persistPlannerSession({
          ...latestSession,
          updatedAt: new Date().toISOString(),
          plannerRun: nextRun,
        }, "规划任务轮询失败");
        if (!exhaustedRetries) {
          schedulePlannerPollInternal(sessionId, planId, baseUrl, runToken);
        }
      }
    },
    [repository, attachPlannerResult, persistPlannerSession],
  );

  // schedulePlannerPoll closes over pollPlanner; we declare it as a ref-backed
  // helper to avoid mutual-recursion lint and stale closure issues.
  const pollPlannerRef = useRef(pollPlanner);
  useEffect(() => {
    pollPlannerRef.current = pollPlanner;
  }, [pollPlanner]);

  function schedulePlannerPollInternal(sessionId: string, planId: string, baseUrl: string, runToken?: string) {
    if (plannerPollTimeoutRef.current !== undefined) {
      window.clearTimeout(plannerPollTimeoutRef.current);
    }
    plannerPollTimeoutRef.current = window.setTimeout(() => {
      void pollPlannerRef.current(sessionId, planId, baseUrl, runToken);
    }, PLANNER_POLL_INTERVAL_MS);
  }

  const schedulePlannerPoll = useCallback(
    (sessionId: string, planId: string, baseUrl: string, runToken?: string) => {
      schedulePlannerPollInternal(sessionId, planId, baseUrl, runToken);
    },
    [],
  );

  // Schedule polling when planner enters running state for the current session.
  useEffect(() => {
    const run = normalizePlannerRunState(currentSession.plannerRun);
    if (run.status !== "running" || !run.planId) {
      clearPlannerPollTimeout();
      return;
    }
    schedulePlannerPoll(currentSession.id, run.planId, run.baseUrl, run.runToken);
  }, [
    currentSession.id,
    currentSession.plannerRun?.planId,
    currentSession.plannerRun?.runToken,
    currentSession.plannerRun?.status,
    clearPlannerPollTimeout,
    schedulePlannerPoll,
  ]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      clearPlannerPollTimeout();
    },
    [clearPlannerPollTimeout],
  );

  const handleStartPlanner = useCallback(async () => {
    if (!project || !canStartPlanner) {
      return;
    }
    setIsPlannerActionRunning(true);
    onPlannerStart?.();
    try {
      const request = exportPlannerInput(project);
      const requestSummary = summarizePlannerRequest(request);
      const requestFingerprint = createPlannerRequestFingerprint(request);
      const baseUrl = resolvePlannerBaseUrl(plannerBaseUrl);
      const runToken = createPlannerRunToken();
      const startedRun: PlannerRunState = {
        status: "running",
        baseUrl,
        runToken,
        requestFingerprint,
        startedAt: new Date().toISOString(),
        requestSummary,
      };
      const submittingSession: TsnSession = {
        ...currentSession,
        updatedAt: new Date().toISOString(),
        plannerRun: startedRun,
      };
      await persistPlannerSession(submittingSession, "规划任务开始提交");
      const response = await startPlannerPlan({ baseUrl, request });
      const run = plannerRunFromStartResponse(startedRun, response);
      const nextSession: TsnSession = {
        ...submittingSession,
        updatedAt: new Date().toISOString(),
        plannerRun: run,
      };
      await persistPlannerSession(nextSession, "规划任务提交完成");
      if (run.status === "running" && run.planId) {
        schedulePlannerPoll(nextSession.id, run.planId, baseUrl, run.runToken);
      } else if (run.status === "succeeded" && run.planId) {
        const completedSession = await attachPlannerResult(nextSession, baseUrl, run.planId, run);
        await persistPlannerSession(completedSession, "规划任务结果已读取");
      }
    } catch (error) {
      const failedSession: TsnSession = {
        ...currentSession,
        updatedAt: new Date().toISOString(),
        plannerRun: {
          ...plannerRun,
          status: "failed",
          baseUrl: resolvePlannerBaseUrl(plannerBaseUrl),
          updatedAt: new Date().toISOString(),
          errorMessage: normalizeError(error),
        },
      };
      await persistPlannerSession(failedSession, "规划任务启动失败");
    } finally {
      setIsPlannerActionRunning(false);
    }
  }, [
    project,
    canStartPlanner,
    plannerBaseUrl,
    currentSession,
    plannerRun,
    persistPlannerSession,
    schedulePlannerPoll,
    attachPlannerResult,
    onPlannerStart,
  ]);

  const handleStopPlanner = useCallback(async () => {
    if (!canStopPlanner) {
      return;
    }
    setIsPlannerActionRunning(true);
    clearPlannerPollTimeout();
    const cancellingRun: PlannerRunState = {
      ...plannerRun,
      status: "cancel_requested",
      runToken: createPlannerRunToken(),
      updatedAt: new Date().toISOString(),
    };
    const cancellingSession: TsnSession = {
      ...currentSession,
      updatedAt: new Date().toISOString(),
      plannerRun: cancellingRun,
    };
    await persistPlannerSession(cancellingSession, "规划任务停止请求已发出");
    try {
      const baseUrl = resolvePlannerBaseUrl(plannerRun.baseUrl);
      const response = await stopPlannerPlan({ baseUrl, planId: plannerRun.planId });
      const run: PlannerRunState = {
        ...cancellingRun,
        baseUrl,
        status: normalizePlannerState(response.data.state),
        planId: response.data.stopped_plan_id ?? response.data.requested_plan_id ?? plannerRun.planId,
        updatedAt: response.timestamp ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorCode: response.err_code === 0 ? undefined : response.err_code,
        errorMessage: response.err_code === 0 ? undefined : response.err_msg,
        traceId: response.trace_id,
      };
      const nextSession: TsnSession = {
        ...cancellingSession,
        updatedAt: new Date().toISOString(),
        plannerRun: run,
      };
      await persistPlannerSession(nextSession, "规划任务停止请求完成");
    } catch (error) {
      const nextSession: TsnSession = {
        ...cancellingSession,
        updatedAt: new Date().toISOString(),
        plannerRun: {
          ...plannerRun,
          status: "running",
          runToken: createPlannerRunToken(),
          updatedAt: new Date().toISOString(),
          errorMessage: normalizeError(error),
        },
      };
      await persistPlannerSession(nextSession, "规划任务停止失败");
    } finally {
      setIsPlannerActionRunning(false);
    }
  }, [
    canStopPlanner,
    clearPlannerPollTimeout,
    plannerRun,
    currentSession,
    persistPlannerSession,
  ]);

  return {
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
  };
}

// ============================================================================
// Module-local pure helpers — co-located per scope-guardian review (Phase 2)
// ============================================================================

export function createPlannerRunToken(): string {
  return `planner-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function plannerRunForAgentResult(
  current: PlannerRunState,
  project: NonNullable<TsnSession["project"]>,
): PlannerRunState {
  if (!current.resultSnapshot && !current.requestFingerprint) {
    return current;
  }
  let nextFingerprint: string;
  try {
    nextFingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
  } catch {
    return createStalePlannerRunState(current);
  }
  if (current.requestFingerprint === nextFingerprint && current.resultSnapshot?.requestFingerprint === nextFingerprint) {
    return current;
  }
  return createStalePlannerRunState(current);
}

export function bundleForAgentResult(
  project: NonNullable<TsnSession["project"]>,
  bundle: TsnSession["bundle"],
  plannerRun: PlannerRunState,
): TsnSession["bundle"] {
  if (!bundle) {
    return bundle;
  }
  const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
  if (plannerRun.resultSnapshot?.requestFingerprint !== fingerprint) {
    return bundle;
  }
  return createArtifactBundle(project, { plannerResult: plannerRun.resultSnapshot });
}

function isExpectedPlannerRun(
  session: TsnSession | undefined,
  planId: string,
  runToken?: string,
): session is TsnSession {
  const run = normalizePlannerRunState(session?.plannerRun);
  return Boolean(
    session
      && run.planId === planId
      && ["running", "cancel_requested"].includes(run.status)
      && (!runToken || run.runToken === runToken),
  );
}

async function isLatestPlannerRun(
  repo: SessionRepository,
  sessionId: string,
  planId: string,
  runToken?: string,
): Promise<boolean> {
  const latestSession = (await repo.list()).find((session) => session.id === sessionId);
  return isExpectedPlannerRun(latestSession, planId, runToken);
}

function assertSuccessfulPlannerResult(
  response: PlannerServiceEnvelope<PlannerResultResponseData>,
  expectedPlanId: string,
): void {
  if (response.err_code !== 0 || response.data.state !== "succeeded") {
    throw new Error(response.data.error_message ?? response.err_msg ?? "规划结果尚未成功生成。");
  }
  if (response.data.plan_id && response.data.plan_id !== expectedPlanId) {
    throw new Error(`规划结果任务 ID 不匹配：期望 ${expectedPlanId}，实际 ${response.data.plan_id}。`);
  }
  if (!response.data.source_outputs) {
    throw new Error("规划结果缺少 source_outputs。");
  }
}

function plannerRunFromStartResponse(
  current: PlannerRunState,
  response: PlannerServiceEnvelope<PlannerStartResponseData>,
): PlannerRunState {
  const state = normalizePlannerState(response.data.state);
  const planId = response.data.plan_id ?? response.data.running_plan_id ?? current.planId;
  return {
    ...current,
    status: state,
    planId,
    startedAt: response.data.started_at ?? current.startedAt,
    updatedAt: response.timestamp ?? new Date().toISOString(),
    runningDurationMs: response.data.running_duration_ms ?? current.runningDurationMs,
    errorCode: response.err_code === 0 ? undefined : response.err_code,
    errorMessage: response.err_code === 0 ? undefined : response.err_msg,
    traceId: response.trace_id,
  };
}

function plannerRunFromQueryResponse(
  current: PlannerRunState,
  response: PlannerServiceEnvelope<PlannerQueryStatusResponseData>,
): PlannerRunState {
  return {
    ...current,
    status: normalizePlannerState(response.data.state),
    planId: response.data.plan_id ?? current.planId,
    startedAt: response.data.started_at ?? current.startedAt,
    updatedAt: response.data.updated_at ?? response.timestamp ?? new Date().toISOString(),
    finishedAt: response.data.finished_at ?? current.finishedAt,
    runningDurationMs: response.data.running_duration_ms ?? current.runningDurationMs,
    internalResult: response.data.internal_result,
    errorCode: response.data.error_code ?? (response.err_code === 0 ? undefined : response.err_code),
    errorMessage: response.data.error_message ?? (response.err_code === 0 ? undefined : response.err_msg),
    traceId: response.trace_id ?? current.traceId,
  };
}

function normalizePlannerState(value: string): PlannerTaskState {
  if ([
    "idle",
    "running",
    "succeeded",
    "failed",
    "busy",
    "cancel_requested",
    "cancelled",
    "no_running_plan",
    "not_found",
    "stale",
    "unknown",
  ].includes(value)) {
    return value as PlannerTaskState;
  }
  return "unknown";
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
