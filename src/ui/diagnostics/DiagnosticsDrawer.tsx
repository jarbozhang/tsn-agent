import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { DiagnosticLogEntry } from "../../diagnostics/diagnostic-log";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";
import { exportRunAudit } from "../../diagnostics/audit-exporter";
import { redactProviderNamesForDisplay, redactProviderNamesInValue } from "../display-redaction";

interface DiagnosticsLogViewProps {
  sessionId: string;
  repository: DiagnosticLogRepository;
}

const FILTERS = [
  { label: "全部", value: "all" },
  { label: "Agent", value: "agent" },
  { label: "会话", value: "session" },
  { label: "文件", value: "artifact" },
  { label: "错误", value: "error" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

export function DiagnosticsLogView({ sessionId, repository }: DiagnosticsLogViewProps) {
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedLogId, setSelectedLogId] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function loadLogs() {
    setIsLoading(true);
    setError(undefined);

    try {
      setLogs(await repository.list(sessionId));
    } catch (innerError) {
      setError(normalizeError(innerError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadLogs();
  }, [sessionId]);

  const filteredLogs = useMemo(() => {
    if (filter === "all") {
      return logs;
    }

    if (filter === "error") {
      return logs.filter((log) => log.level === "error" || log.level === "warn");
    }

    return logs.filter((log) => log.category === filter);
  }, [filter, logs]);
  const selectedLog = filteredLogs.find((log) => log.id === selectedLogId) ?? filteredLogs[0];

  useEffect(() => {
    if (filteredLogs.length === 0) {
      setSelectedLogId(undefined);
      return;
    }

    if (!filteredLogs.some((log) => log.id === selectedLogId)) {
      setSelectedLogId(filteredLogs[0].id);
    }
  }, [filteredLogs, selectedLogId]);

  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-toolbar">
        <div className="diag-filter-group" role="group" aria-label="日志筛选">
          {FILTERS.map((item) => (
            <button
              className={filter === item.value ? "diag-filter active" : "diag-filter"}
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="btn" type="button" onClick={loadLogs} disabled={isLoading}>
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </div>

      {error && <div className="diagnostics-error">日志加载失败：{redactProviderNamesForDisplay(error)}</div>}
      {!error && filteredLogs.length === 0 && (
        <div className="empty-panel mono">{isLoading ? "正在加载日志" : "当前会话暂无诊断日志"}</div>
      )}
      {!error && filteredLogs.length > 0 && (
        <div className="master-detail-layout diagnostics-detail-layout">
          <ol className="diagnostics-list master-list" aria-label="当前会话诊断日志">
            {filteredLogs.map((log) => (
              <li key={log.id}>
                <button
                  className={`diagnostics-item master-list-item ${log.level} ${selectedLog?.id === log.id ? "active" : ""}`}
                  type="button"
                  aria-selected={selectedLog?.id === log.id}
                  onClick={() => setSelectedLogId(log.id)}
                >
                  <div className="diagnostics-row">
                    <span className={`diag-level ${log.level}`}>{log.level.toUpperCase()}</span>
                    <span className="diag-category">{categoryLabel(log.category)}</span>
                    <time className="diag-time">{formatTime(log.createdAt)}</time>
                  </div>
                  <strong>{redactProviderNamesForDisplay(log.message)}</strong>
                  <div className="diagnostics-meta mono">
                    {log.runId && <span>run={redactProviderNamesForDisplay(log.runId)}</span>}
                    {typeof log.durationMs === "number" && <span>{log.durationMs}ms</span>}
                    {log.details && <span>details</span>}
                  </div>
                </button>
              </li>
            ))}
          </ol>
          <DiagnosticLogDetail log={selectedLog} />
        </div>
      )}
    </div>
  );
}

function DiagnosticLogDetail({ log }: { log?: DiagnosticLogEntry }) {
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "exported" | "cancelled" | "error">("idle");
  const [exportMessage, setExportMessage] = useState<string>();

  if (!log) {
    return <div className="empty-panel mono">请选择一条日志查看详情</div>;
  }

  const canExportAudit = log.category === "agent" && Boolean(log.runId) && Boolean(log.sessionId);

  async function handleExport() {
    if (!log?.runId || !log?.sessionId) {
      return;
    }
    setExportStatus("exporting");
    setExportMessage(undefined);
    try {
      const result = await exportRunAudit({ sessionId: log.sessionId, runId: log.runId });
      if (result.kind === "cancelled") {
        setExportStatus("cancelled");
        setExportMessage("已取消");
        return;
      }
      setExportStatus("exported");
      setExportMessage(`已导出到 ${result.destination ?? "目标路径"}`);
    } catch (error) {
      setExportStatus("error");
      setExportMessage(redactProviderNamesForDisplay(normalizeError(error)));
    }
  }

  return (
    <section className={`detail-surface diagnostics-detail ${log.level}`} aria-label="日志详情">
      <div className="detail-surface-header">
        <div>
          <p className="drawer-kicker">Log Detail</p>
          <h3>{redactProviderNamesForDisplay(log.message)}</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {canExportAudit && (
            <button
              type="button"
              className="btn"
              onClick={handleExport}
              disabled={exportStatus === "exporting"}
              aria-label="导出运行 audit"
              title="导出运行 audit（脱敏后）"
            >
              <Download size={14} aria-hidden="true" />
              {exportStatus === "exporting" ? "导出中…" : "导出 audit"}
            </button>
          )}
          <span className={`diag-level ${log.level}`}>{log.level.toUpperCase()}</span>
        </div>
      </div>
      <div className="detail-grid">
        <DetailField label="类别" value={categoryLabel(log.category)} />
        <DetailField label="时间" value={formatDateTime(log.createdAt)} />
        <DetailField label="Run" value={log.runId ? redactProviderNamesForDisplay(log.runId) : "无"} />
        <DetailField label="耗时" value={typeof log.durationMs === "number" ? `${log.durationMs}ms` : "无"} />
      </div>
      {exportMessage && (
        <p
          role="status"
          style={{
            margin: "8px 0",
            padding: "6px 10px",
            background: exportStatus === "error" ? "#fff5f5" : "#f0f9ff",
            color: exportStatus === "error" ? "#a00" : "#0050a0",
            borderRadius: 4,
          }}
        >
          {exportMessage}
        </p>
      )}
      {log.details ? (
        <pre className="diagnostics-detail-json">
          {JSON.stringify(redactProviderNamesInValue(log.details), null, 2)}
        </pre>
      ) : (
        <div className="empty-panel mono">该日志没有附加详情</div>
      )}
    </section>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function categoryLabel(category: DiagnosticLogEntry["category"]): string {
  switch (category) {
    case "agent":
      return "Agent";
    case "artifact":
      return "文件";
    case "session":
      return "会话";
    case "system":
      return "系统";
  }
}

function formatTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && value.length < 16 ? new Date(numeric) : new Date(value);

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDateTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && value.length < 16 ? new Date(numeric) : new Date(value);

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}
