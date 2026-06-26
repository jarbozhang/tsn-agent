import { useCallback, useEffect, useRef } from "react";
import { TimeSyncOffsetChart } from "../time-sync-offset-chart";
import {
  type HardwareCheckResult,
  type HardwareEvent,
  type HardwareStartResult,
  type HardwareUiState,
  type IssueOut,
  invokeHardwareCheck,
  invokeHardwareMetrics,
  invokeHardwareQuery,
  invokeHardwareStart,
  invokeHardwareStop,
  isStartable,
  type MetricsPayload,
  nextHardwareState,
  type TaskStatusOut,
} from "./hardware-deploy";

/**
 * U8：硬件部署子 tab 主面板 —— 状态机驱动 + 双定时器轮询 + 按钮状态表 + issues 纯文本渲染。
 *
 * 驱动：点开始 → check → start（含 validate）→ confirm（created 有限重试）→ observing。
 * observing 两定时器（KTD8）：metrics 1s 喂图、task_query 5s 探终态；软超时兜底。轮询随
 * 会话切换 / 手动停 / 终态 清理（runId 取消 + 清 interval）。切会话对旧 observing 任务
 * best-effort 停（R7/KTD9）。
 */

const DEFAULT_DURATION_S = 60;
const METRICS_INTERVAL_MS = 1000;
const QUERY_INTERVAL_MS = 5000;
const CONFIRM_RETRY_MS = 2000;
const CONFIRM_MAX_TRIES = 12;
const SOFT_TIMEOUT_GRACE_MS = 30_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HardDeployPanelProps {
  sessionId: string;
  inTimeSyncStage: boolean;
  treeConfirmed: boolean;
  hardwareState: HardwareUiState;
  onHardwareStateChange: (state: HardwareUiState) => void;
  onGoSoftSim: () => void;
  // 命令通道（测试注入替身）。
  check?: () => Promise<HardwareCheckResult>;
  start?: (sessionId: string, durationS?: number) => Promise<HardwareStartResult>;
  query?: (sessionId: string) => Promise<TaskStatusOut>;
  metrics?: (sessionId: string) => Promise<MetricsPayload>;
  stop?: (sessionId: string) => Promise<TaskStatusOut>;
}

export function HardDeployPanel({
  sessionId,
  inTimeSyncStage,
  treeConfirmed,
  hardwareState,
  onHardwareStateChange,
  onGoSoftSim,
  check = invokeHardwareCheck,
  start = invokeHardwareStart,
  query = invokeHardwareQuery,
  metrics = invokeHardwareMetrics,
  stop = invokeHardwareStop,
}: HardDeployPanelProps) {
  // stateRef = driver 的状态真值源：只由 dispatch 同步更新（不在渲染期从 prop 重赋值——那会把
  // dispatch 领先设置的值用滞后的 prop 覆盖，导致快速链路里 dispatch 读到陈旧态而 no-op）。
  // 会话切换由 TimeSyncPanel 的 key={sessionId} 重挂本组件，stateRef 随之以新会话 hardwareState 重初始化。
  const stateRef = useRef(hardwareState);
  // 记本组件最后一次 dispatch 出的值，用来分辨「prop 变化来自本组件」还是「外部重置」。
  const lastDispatchedRef = useRef(hardwareState);
  const runIdRef = useRef(0);
  const metricsTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const queryTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const metricsBusyRef = useRef(false);
  const queryBusyRef = useRef(false);
  const startedAtRef = useRef(0);
  const durationRef = useRef(DEFAULT_DURATION_S);
  // observing 中的活动任务归属（driver 管理，非 render 管理）——切会话 best-effort 停用。
  const activeTaskRef = useRef<{ sessionId: string } | null>(null);
  // 命令道镜像进 ref：让 driver 回调/清理 effect 的 deps 不含会 churn 的命令 prop（否则
  // 调用方每次渲染传新替身会让清理 effect 反复重跑、误增 runId 取消进行中的链路）。
  const checkRef = useRef(check);
  checkRef.current = check;
  const startRef = useRef(start);
  startRef.current = start;
  const queryRef = useRef(query);
  queryRef.current = query;
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const clearTimers = useCallback(() => {
    if (metricsTimerRef.current) clearInterval(metricsTimerRef.current);
    if (queryTimerRef.current) clearInterval(queryTimerRef.current);
    metricsTimerRef.current = undefined;
    queryTimerRef.current = undefined;
    metricsBusyRef.current = false;
    queryBusyRef.current = false;
  }, []);

  const dispatch = useCallback(
    (event: HardwareEvent): HardwareUiState => {
      const next = nextHardwareState(stateRef.current, event);
      stateRef.current = next;
      lastDispatchedRef.current = next;
      onHardwareStateChange(next);
      return next;
    },
    [onHardwareStateChange],
  );

  // 外部重置同步（修死键）：App 切会话把 hardwareState 归 idle 是 post-commit effect，落后于本组件
  // 的 key 重挂——重挂时 useRef 拿到的是旧会话的滞后 prop（如 observing），之后 prop 变 idle 但
  // stateRef 不跟，导致新会话「开始」按钮被 isStartable(stateRef=observing) 判死。仅当 prop 变化
  // 不是本组件 dispatch 产生（!== lastDispatched）时，把它同步进 stateRef（dispatch 自身的 prop
  // 变化不会进这支，避免 clobber 领先值）。
  useEffect(() => {
    if (hardwareState !== lastDispatchedRef.current) {
      stateRef.current = hardwareState;
      lastDispatchedRef.current = hardwareState;
    }
  }, [hardwareState]);

  // 会话切换 / 卸载：取消循环 + 清定时器 + best-effort 停旧 observing 任务（R7/KTD9）。
  // 只依赖 sessionId——cleanup 仅在真切会话/卸载时跑，不被命令 prop 的身份变动误触发。
  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      clearTimers();
      const active = activeTaskRef.current;
      if (active && active.sessionId === sessionId) {
        void stopRef.current(sessionId).catch(() => {});
      }
      activeTaskRef.current = null;
    };
  }, [sessionId, clearTimers]);

  const driveObserving = useCallback(
    (myRun: number, sid: string) => {
      metricsTimerRef.current = setInterval(() => {
        if (myRun !== runIdRef.current || metricsBusyRef.current) return;
        metricsBusyRef.current = true;
        void metricsRef
          .current(sid)
          .then((payload) => {
            if (myRun === runIdRef.current) dispatch({ kind: "metrics", payload });
          })
          .catch(() => {}) // 单次失败忽略，下拍重试。
          .finally(() => {
            metricsBusyRef.current = false;
          });
      }, METRICS_INTERVAL_MS);

      queryTimerRef.current = setInterval(() => {
        if (myRun !== runIdRef.current) return;
        // 软超时兜底：elapsed > duration + 余量仍无终态 → 停轮询、落 stopped。
        if (
          Date.now() - startedAtRef.current >
          durationRef.current * 1000 + SOFT_TIMEOUT_GRACE_MS
        ) {
          clearTimers();
          activeTaskRef.current = null;
          dispatch({ kind: "softTimeout" });
          return;
        }
        if (queryBusyRef.current) return;
        queryBusyRef.current = true;
        void queryRef
          .current(sid)
          .then((result) => {
            if (myRun !== runIdRef.current) return;
            const next = dispatch({ kind: "queried", result });
            if (next.status !== "observing") {
              clearTimers();
              activeTaskRef.current = null;
            }
          })
          .catch(() => {})
          .finally(() => {
            queryBusyRef.current = false;
          });
      }, QUERY_INTERVAL_MS);
    },
    [dispatch, clearTimers],
  );

  const handleStart = useCallback(async () => {
    if (!inTimeSyncStage || !treeConfirmed) return;
    if (!isStartable(stateRef.current)) return;
    clearTimers();
    runIdRef.current += 1;
    const myRun = runIdRef.current;
    const sid = sessionId;
    startedAtRef.current = Date.now();
    durationRef.current = DEFAULT_DURATION_S;

    dispatch({ kind: "begin" });
    try {
      const checkRes = await checkRef.current();
      if (myRun !== runIdRef.current) return;
      if (dispatch({ kind: "checked", result: checkRes }).status !== "starting") return;

      const startRes = await startRef.current(sid, DEFAULT_DURATION_S);
      if (myRun !== runIdRef.current) return;
      if (dispatch({ kind: "started", result: startRes }).status !== "confirming") return;
      activeTaskRef.current = { sessionId: sid };

      // confirm 循环：created 有限重试，直到 active（observing）或终态。
      for (let i = 0; i < CONFIRM_MAX_TRIES; i++) {
        let q: TaskStatusOut;
        try {
          q = await queryRef.current(sid);
        } catch {
          // 确认阶段单次 query 失败视为可重试网络抖动（同 observing），不立刻判失败/孤儿任务。
          await delay(CONFIRM_RETRY_MS);
          if (myRun !== runIdRef.current) return;
          continue;
        }
        if (myRun !== runIdRef.current) return;
        const afterQ = dispatch({ kind: "queried", result: q });
        if (afterQ.status === "observing") {
          driveObserving(myRun, sid);
          return;
        }
        if (afterQ.status !== "confirming") {
          activeTaskRef.current = null;
          return; // 终态
        }
        await delay(CONFIRM_RETRY_MS);
        if (myRun !== runIdRef.current) return;
      }
      dispatch({ kind: "failed", message: "任务长时间未进入运行态，请重试。" });
      activeTaskRef.current = null;
    } catch (e) {
      if (myRun !== runIdRef.current) return;
      dispatch({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      activeTaskRef.current = null;
    }
  }, [inTimeSyncStage, treeConfirmed, sessionId, dispatch, clearTimers, driveObserving]);

  const handleStop = useCallback(async () => {
    if (stateRef.current.status !== "observing") return;
    clearTimers();
    runIdRef.current += 1; // 取消 observing 循环。
    const myRun = runIdRef.current;
    const sid = sessionId;
    try {
      const result = await stopRef.current(sid);
      if (myRun !== runIdRef.current) return; // 停止往返期间切会话/重开 → 不把旧结果泄漏进新态。
      dispatch({ kind: "stopResult", result });
    } catch (e) {
      if (myRun !== runIdRef.current) return;
      dispatch({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
    activeTaskRef.current = null;
  }, [sessionId, dispatch, clearTimers]);

  const handleRetry = useCallback(() => {
    dispatch({ kind: "reset" });
  }, [dispatch]);

  // 门控空态：未到阶段 / 树未确认。
  if (!inTimeSyncStage || !treeConfirmed) {
    return (
      <div className="hard-deploy-empty">
        <h2>硬件部署</h2>
        <p className="hard-deploy-empty__note">
          {!inTimeSyncStage
            ? "请先进入时钟同步阶段。"
            : "请先确认时钟树（设好 GM），再把配置下发到真实硬件。"}
        </p>
        <button type="button" className="btn" onClick={onGoSoftSim}>
          先用软件仿真验证
        </button>
      </div>
    );
  }

  return (
    <div className="hard-deploy">
      <div className="panel-heading">
        <div>
          <h2>硬件部署</h2>
          <p>把已确认的时钟同步配置下发到真实硬件，实时观测各节点相对 GM 的时钟偏移。</p>
        </div>
      </div>

      <div className="sim-actions" role="group" aria-label="硬件部署操作">
        <MainButton state={hardwareState} onStart={handleStart} onRetry={handleRetry} />
        {hardwareState.status === "observing" && (
          <button type="button" className="btn" onClick={() => void handleStop()}>
            停止任务
          </button>
        )}
      </div>

      <HardDeployBody state={hardwareState} />
    </div>
  );
}

function MainButton({
  state,
  onStart,
  onRetry,
}: {
  state: HardwareUiState;
  onStart: () => void;
  onRetry: () => void;
}) {
  switch (state.status) {
    case "idle":
      return (
        <button type="button" className="btn primary" onClick={onStart}>
          开始硬件部署
        </button>
      );
    case "checking":
    case "starting":
    case "confirming":
      return (
        <button type="button" className="btn primary" disabled>
          部署中…
        </button>
      );
    case "observing":
      return null;
    case "error":
      return (
        <button type="button" className="btn primary" onClick={onRetry}>
          重试
        </button>
      );
    default:
      // done / stopped / failed
      return (
        <button type="button" className="btn primary" onClick={onRetry}>
          重新部署
        </button>
      );
  }
}

/** metrics 采集态：collecting=采集中（动态骨架）/ no_data=暂无数据（静态）/ ready=画图。 */
function metricsStatusOf(payload: MetricsPayload | undefined): string | undefined {
  if (!payload) return undefined;
  // payload 是两层并集（顶层 | { data?: ... }）。逐字段窄取 + typeof 运行时守卫，不用整形 intersection
  // cast（后者断言整个形状、变更时静默读错层）；每处访问都被 typeof 兜住，形状变了也只会返回 undefined。
  const top = (payload as { metrics_status?: unknown }).metrics_status;
  if (typeof top === "string") return top;
  const nested = (payload as { data?: { metrics_status?: unknown } }).data?.metrics_status;
  return typeof nested === "string" ? nested : undefined;
}

function HardDeployBody({ state }: { state: HardwareUiState }) {
  switch (state.status) {
    case "idle":
      return <div className="empty-panel mono">点上方按钮，开始把配置下发到硬件。</div>;
    case "checking":
      return <div className="empty-panel mono">正在检查硬件环境…</div>;
    case "starting":
      return <div className="empty-panel mono">正在校验配置并启动任务…</div>;
    case "confirming":
      return <div className="empty-panel mono">任务已受理，正在确认运行状态…</div>;
    case "error":
      return (
        <div className="hard-deploy-error">
          <p className="transfer-notice error" role="alert">
            {state.message}
          </p>
          <IssueList issues={state.issues} />
        </div>
      );
    case "observing":
    case "done":
    case "stopped":
    case "failed": {
      const metrics = "metrics" in state ? state.metrics : undefined;
      return (
        <div className="hard-deploy-observe">
          <TerminalNote state={state} />
          <MetricsView state={state.status} metrics={metrics} />
        </div>
      );
    }
    default:
      return null;
  }
}

function TerminalNote({ state }: { state: HardwareUiState }) {
  switch (state.status) {
    case "done":
      return (
        <div className="sim-overall converged" role="status">
          任务已完成
        </div>
      );
    case "stopped":
      return (
        <div className="sim-overall" role="status">
          任务已停止
        </div>
      );
    case "failed":
      return (
        <p className="transfer-notice error" role="alert">
          任务失败：{state.message}
        </p>
      );
    default:
      return null;
  }
}

function MetricsView({
  state,
  metrics,
}: {
  state: HardwareUiState["status"];
  metrics: MetricsPayload | undefined;
}) {
  const status = metricsStatusOf(metrics);
  // 观测中且还没数据：区分 collecting（动态骨架）与 no_data（静态文案）。
  if (state === "observing" && (!metrics || status === "collecting")) {
    return <div className="hard-deploy-collecting mono">采集中…</div>;
  }
  if (status === "no_data") {
    return <div className="empty-panel mono">暂无数据</div>;
  }
  return <TimeSyncOffsetChart metrics={metrics} title="时钟偏移曲线" />;
}

/** issues 纯文本节点渲染（KTD12 防 XSS，不走 markdown）+ R1 sync_period 专门引导。 */
function IssueList({ issues }: { issues: IssueOut[] | undefined }) {
  if (!issues || issues.length === 0) return null;
  const hitsSyncPeriod = issues.some(
    (i) =>
      /sync/i.test(i.code ?? "") ||
      i.message.includes("sync_period") ||
      i.message.includes("同步周期"),
  );
  return (
    <div className="hard-deploy-issues">
      <ul>
        {issues.map((issue) => (
          <li
            // 校验问题列表无稳定 id：用 severity+code+message 作内容键（同一次结果内稳定）。
            key={`${issue.severity}-${issue.code ?? ""}-${issue.message}`}
            className={issue.severity === "ERROR" ? "issue-error" : "issue-warn"}
          >
            <span className="issue-sev">{issue.severity}</span>
            {issue.message}
          </li>
        ))}
      </ul>
      {hitsSyncPeriod && (
        <p className="host-form-hint">
          提示：硬件仅支持同步周期 1000 / 500 / 250 / 125 ms。当前配置不在其中，请回时间同步阶段把
          同步周期改成上述值之一再重试。
        </p>
      )}
    </div>
  );
}
