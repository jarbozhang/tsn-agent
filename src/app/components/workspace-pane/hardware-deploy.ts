import { invoke } from "@tauri-apps/api/core";
import type { TimeSyncMetricsQueryResponse } from "../time-sync-offset-chart";

/**
 * U7：硬件部署前端契约 —— 类型 + invoke 包装 + 纯状态机 `nextHardwareState`。
 *
 * 沿用 timesync-sim.ts 的「判别联合 state + invoke 包装 + 纯函数可单测」原则；但本状态机迁移
 * 函数是本期新写（timesync-sim 无对应物，SimUiState 推进逻辑内联在 App.tsx）。
 *
 * 命令出参 camelCase（与 hardware_command.rs serde 对齐）；metrics 走 snake_case 透传（KTD11），
 * 形状即 echarts 组件的 TimeSyncMetricsQueryResponse。
 */

export type MetricsPayload = TimeSyncMetricsQueryResponse;

export interface HardwareCheckResult {
  healthzOk: boolean;
  hardwareAvailable: boolean;
  reason?: string;
}

export interface IssueOut {
  severity: string;
  category?: string;
  code?: string;
  message: string;
  location?: string;
}

export interface ValidateOut {
  verdict: string;
  summary?: string;
  ready: boolean;
  taskStartCompatible: boolean;
  issues: IssueOut[];
}

export interface StartOut {
  status: string;
  accepted: boolean;
}

export interface HardwareStartResult {
  taskId: string;
  validate: ValidateOut;
  /** 启动门未过（ready && taskStartCompatible 不满足）时缺省。 */
  start?: StartOut;
}

export interface TaskStatusOut {
  status: string;
  verdict?: string;
  summary?: string;
}

/** App 级硬件部署运行态（切 tab/子 tab 不丢，随 sessionId 重置）。 */
export type HardwareUiState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "starting" }
  | { status: "confirming"; taskId: string }
  | { status: "observing"; taskId: string; metrics?: MetricsPayload }
  // 停止过渡态：已请求停止、正在确认远端真正终止（给硬件测量流断开留时间，避免立刻重部署串流）。
  | { status: "stopping"; metrics?: MetricsPayload }
  | { status: "done"; metrics?: MetricsPayload }
  | { status: "stopped"; metrics?: MetricsPayload }
  | { status: "failed"; message: string; metrics?: MetricsPayload }
  | { status: "error"; message: string; issues?: IssueOut[] };

/** 驱动状态机的事件（App effect 调命令后 dispatch）。 */
export type HardwareEvent =
  | { kind: "begin" }
  | { kind: "checked"; result: HardwareCheckResult }
  | { kind: "started"; result: HardwareStartResult }
  | { kind: "queried"; result: TaskStatusOut }
  | { kind: "metrics"; payload: MetricsPayload }
  | { kind: "stopBegin" }
  | { kind: "stopResult"; result: TaskStatusOut }
  | { kind: "softTimeout" }
  | { kind: "failed"; message: string }
  | { kind: "reset" };

type StatusClass = "transient" | "active" | "done" | "stopped" | "failed";

/**
 * 把 task_query / task_stop 的 status 归类（KTD8 核心）：
 * - `created` = 受理后的合法瞬时态 → transient（**不判 error**，继续等）。
 * - `queued`/`running` = active（继续观测）。
 * - `done`/`stopped` 各自终态；`failed`/`timeout` 归 failed。
 * - 未知值 → active（防御：宁可继续观测也不误判终态）。
 */
export function classifyStatus(status: string): StatusClass {
  switch (status) {
    case "created":
      return "transient";
    case "queued":
    case "running":
      return "active";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "failed":
    case "timeout":
      return "failed";
    default:
      return "active";
  }
}

const TERMINAL: ReadonlySet<HardwareUiState["status"]> = new Set([
  "done",
  "stopped",
  "failed",
  "error",
  "idle",
]);

/** 是否可发起新部署（idle / 终态）——非此即正在跑，「开始」按钮禁用（防孤儿，KTD9）。 */
export function isStartable(state: HardwareUiState): boolean {
  return TERMINAL.has(state.status);
}

/**
 * 纯状态机迁移（无副作用，便于单测）。App effect 据返回的 state 决定下一步调哪个命令。
 * 关键修正（doc-review）：created 不判 error、终态以 task_query.status 为权威、stop 按返回
 * status 分流（done≠stopped）、终态可 reset 回 idle 重试。
 */
export function nextHardwareState(prev: HardwareUiState, event: HardwareEvent): HardwareUiState {
  switch (event.kind) {
    case "begin":
      // 仅允许从 idle / 终态 / error 重新开始。
      return TERMINAL.has(prev.status) ? { status: "checking" } : prev;

    case "checked": {
      if (prev.status !== "checking") return prev;
      if (!event.result.hardwareAvailable) {
        return {
          status: "error",
          message: event.result.reason ?? "硬件环境不可用。",
        };
      }
      return { status: "starting" };
    }

    case "started": {
      if (prev.status !== "starting") return prev;
      const { validate, start, taskId } = event.result;
      if (!start) {
        // 校验门未过：展示 issues。
        return {
          status: "error",
          message: validate.summary ?? `配置校验未通过（${validate.verdict}）。`,
          issues: validate.issues,
        };
      }
      if (!start.accepted) {
        return { status: "error", message: "任务未被受理。" };
      }
      return { status: "confirming", taskId };
    }

    case "queried": {
      const cls = classifyStatus(event.result.status);
      if (prev.status === "confirming") {
        switch (cls) {
          case "transient":
            return prev; // created → 继续等（不判 error）。
          case "active":
            return { status: "observing", taskId: prev.taskId };
          case "done":
            return { status: "done" };
          case "stopped":
            return { status: "stopped" };
          case "failed":
            return {
              status: "failed",
              message: event.result.summary ?? "任务失败。",
            };
        }
      }
      if (prev.status === "observing") {
        switch (cls) {
          case "transient":
          case "active":
            return prev;
          case "done":
            return { status: "done", metrics: prev.metrics };
          case "stopped":
            return { status: "stopped", metrics: prev.metrics };
          case "failed":
            return {
              status: "failed",
              message: event.result.summary ?? "任务失败。",
              metrics: prev.metrics,
            };
        }
      }
      return prev;
    }

    case "metrics":
      if (prev.status !== "observing") return prev;
      return { status: "observing", taskId: prev.taskId, metrics: event.payload };

    case "stopBegin":
      // 点停止 → 进入「停止中」过渡态（保留曲线），由 driver 轮询确认远端真正终止后再落终态。
      if (prev.status !== "observing") return prev;
      return { status: "stopping", metrics: prev.metrics };

    case "stopResult": {
      if (prev.status !== "stopping") return prev;
      const metrics = prev.metrics;
      // 按返回 status 分流——任务可能恰好跑完（done/failed/timeout），不硬编码 stopped。
      switch (classifyStatus(event.result.status)) {
        case "done":
          return { status: "done", metrics };
        case "failed":
          return {
            status: "failed",
            message: event.result.summary ?? "任务失败。",
            metrics,
          };
        default:
          return { status: "stopped", metrics };
      }
    }

    case "softTimeout":
      // 软超时（elapsed>duration+余量仍无终态）：停轮询、落 stopped（中性「已停止」，保留曲线）。
      if (prev.status !== "observing") return prev;
      return { status: "stopped", metrics: prev.metrics };

    case "failed":
      return { status: "error", message: event.message };

    case "reset":
      return { status: "idle" };

    default:
      return prev;
  }
}

// ---------- invoke 包装（测试可注入替身）----------

export async function invokeHardwareCheck(): Promise<HardwareCheckResult> {
  return await invoke<HardwareCheckResult>("hardware_check");
}

export async function invokeHardwareStart(
  sessionId: string,
  durationS?: number,
): Promise<HardwareStartResult> {
  return await invoke<HardwareStartResult>("hardware_start", {
    request: { sessionId, durationS },
  });
}

export async function invokeHardwareQuery(sessionId: string): Promise<TaskStatusOut> {
  return await invoke<TaskStatusOut>("hardware_query", { request: { sessionId } });
}

export async function invokeHardwareMetrics(sessionId: string): Promise<MetricsPayload> {
  return await invoke<MetricsPayload>("hardware_metrics", { request: { sessionId } });
}

export async function invokeHardwareStop(sessionId: string): Promise<TaskStatusOut> {
  return await invoke<TaskStatusOut>("hardware_stop", { request: { sessionId } });
}
