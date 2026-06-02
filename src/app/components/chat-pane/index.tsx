import { redactProviderNamesForDisplay } from "../../../ui/display-redaction";
import type { AgentEvent, AgentStepDetail } from "../../../agent/agent-types";
import type { AgentRunPhase } from "../../hooks/use-agent-run-controller";

export type { AgentRunPhase };

export function Step({
  index,
  label,
  status,
}: {
  index: string;
  label: string;
  status: "locked" | "current" | "waiting_confirmation" | "confirmed" | "error";
}) {
  const className = status === "confirmed" ? "passed" : status;
  return (
    <div className={`stepper-item ${className}`}>
      <span className="si-num">{index}</span>
      <span className="si-label">{label}</span>
    </div>
  );
}

export function AgentWaitingIndicator() {
  return (
    <div className="agent-waiting" role="status" aria-live="polite">
      <span className="agent-waiting-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>正在连接智能助手，并结合当前会话上下文生成下一步规划</span>
    </div>
  );
}

export function AgentRunStatusBar({ elapsedSeconds, phase }: { elapsedSeconds: number; phase: AgentRunPhase }) {
  const message = getAgentRunStatusMessage(phase);
  return (
    <div className={`agent-run-status ${phase}`} role="status" aria-live="polite" data-testid="agent-run-status">
      <span className="agent-waiting-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{message}</span>
      <span className="agent-run-elapsed mono">已运行 {elapsedSeconds} 秒</span>
    </div>
  );
}

export function getAgentRunStatusMessage(phase: AgentRunPhase): string {
  if (phase === "waiting") {
    return "智能助手仍在处理，可能正在等待工具或子任务返回";
  }
  if (phase === "streaming") {
    return "智能助手正在持续推理，结果会继续更新";
  }
  return "智能助手正在连接并准备当前会话上下文";
}

export function LegacyOriginBanner({ onAcknowledge }: { onAcknowledge: () => void | Promise<void> }) {
  return (
    <aside className="legacy-origin-banner" role="note" aria-label="历史会话提示">
      <strong className="legacy-origin-banner__title">本会话由旧本地模式生成</strong>
      <p className="legacy-origin-banner__body">建议新开会话验证，以使用真实智能助手运行时校验拓扑与流量规划。</p>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          void onAcknowledge();
        }}
      >
        我知道了
      </button>
    </aside>
  );
}

export function TelegramSendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="telegram-send-icon"
    >
      <path
        fill="currentColor"
        d="M20.68 4.44c.42-.18.85.18.73.62l-3.78 14.18c-.11.41-.61.57-.95.31l-5.38-4.02-2.76 2.66c-.29.28-.78.13-.86-.27l-.95-4.73-4.36-1.36c-.44-.14-.48-.76-.06-.96L20.68 4.44Z"
      />
      <path
        fill="var(--accent)"
        d="M8.92 12.95 17.8 7.4c.18-.11.36.13.21.28l-7.32 7.04-.29 2.73-1.48-4.5Z"
      />
    </svg>
  );
}

export function stampAgentEvents<T extends { id: string; createdAt?: string }>(events: T[], createdAt: string): T[] {
  return events.map((event, index) => ({
    ...event,
    id: `${event.id}-${createdAt.replace(/[^0-9A-Za-z]/g, "")}-${index}`,
    createdAt,
  }));
}

export function AgentStepSummaryGroup({
  runId,
  events,
  stepDetails,
  expandedTraceId,
  onToggleExpanded,
}: {
  runId: string;
  events: AgentEvent[];
  stepDetails?: Record<string, AgentStepDetail>;
  expandedTraceId?: string;
  onToggleExpanded: (traceId: string) => void;
}) {
  const runEvents = events.filter((event) => event.runId === runId);
  if (runEvents.length === 0) {
    return null;
  }
  return (
    <ol className="agent-step-summary-group" aria-label="本轮步骤摘要" role="list">
      {runEvents.map((event, idx) => {
        const traceId = event.traceId ?? event.detailRef ?? event.id;
        const isExpanded = expandedTraceId === traceId;
        const detail = stepDetails?.[traceId];
        const stepNumber = idx + 1;
        const stepState = deriveStepCardState(event, detail);
        return (
          <li key={`${runId}-${traceId}`}>
            <button
              type="button"
              className={`agent-step-card agent-step-card--${stepState}`}
              aria-expanded={isExpanded}
              aria-controls={`agent-step-detail-${traceId}`}
              onClick={() => onToggleExpanded(traceId)}
            >
              <strong className="agent-step-card__index">{stepNumber}.</strong>
              <span className="agent-step-card__state">{stepCardStateLabel(stepState)}</span>
              <span>{redactProviderNamesForDisplay(event.title)}</span>
            </button>
            {isExpanded && (
              <div id={`agent-step-detail-${traceId}`} role="region" className="agent-step-detail">
                {detail ? (
                  <AgentStepDetailView detail={detail} />
                ) : (
                  <p className="agent-step-detail__empty">该步骤没有保存更多详情</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

type StepCardState = "pending" | "streaming" | "success" | "error" | "no-detail" | "orphan" | "aborted";

function deriveStepCardState(event: AgentEvent, detail?: AgentStepDetail): StepCardState {
  if (event.kind === "agent_run_aborted" || event.status === "aborted") {
    return "aborted";
  }
  if (event.status === "error") {
    return "error";
  }
  if (event.status === "pending") {
    return "pending";
  }
  if (event.status === "streaming") {
    return "streaming";
  }
  if (event.status === "success") {
    return detail ? "success" : "no-detail";
  }
  if (event.toolUseId && !detail) {
    return "orphan";
  }
  return detail ? "success" : "no-detail";
}

function stepCardStateLabel(state: StepCardState): string {
  const labels: Record<StepCardState, string> = {
    pending: "进行中",
    streaming: "流式",
    success: "成功",
    error: "失败",
    "no-detail": "已记录",
    orphan: "未配对",
    aborted: "已中止",
  };
  return labels[state];
}

function AgentStepDetailView({ detail }: { detail: AgentStepDetail }) {
  return (
    <dl className="agent-step-detail__grid">
      {detail.toolName && (
        <>
          <dt className="agent-step-detail__label">工具</dt>
          <dd className="agent-step-detail__value">{redactProviderNamesForDisplay(detail.toolName)}</dd>
        </>
      )}
      {detail.inputSummary && (
        <>
          <dt className="agent-step-detail__label">输入</dt>
          <dd className="agent-step-detail__value">{redactProviderNamesForDisplay(detail.inputSummary)}</dd>
        </>
      )}
      {detail.outputSummary && (
        <>
          <dt className="agent-step-detail__label">输出</dt>
          <dd className="agent-step-detail__value">{redactProviderNamesForDisplay(detail.outputSummary)}</dd>
        </>
      )}
      {detail.errorSummary && (
        <>
          <dt className="agent-step-detail__label agent-step-detail__label--error">错误</dt>
          <dd className="agent-step-detail__value agent-step-detail__value--error">
            {redactProviderNamesForDisplay(detail.errorSummary)}
          </dd>
        </>
      )}
      {typeof detail.durationMs === "number" && (
        <>
          <dt className="agent-step-detail__label">耗时</dt>
          <dd className="agent-step-detail__value">{detail.durationMs}ms</dd>
        </>
      )}
      <dt className="agent-step-detail__label">traceId</dt>
      <dd className="agent-step-detail__value agent-step-detail__value--mono">{detail.traceId}</dd>
      <dt className="agent-step-detail__label">runId</dt>
      <dd className="agent-step-detail__value agent-step-detail__value--mono">{detail.runId}</dd>
    </dl>
  );
}
