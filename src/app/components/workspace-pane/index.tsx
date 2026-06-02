import { Handle, Position, type NodeProps } from "@xyflow/react";
import { RefreshCw, Square } from "lucide-react";
import {
  type PlannerRunState,
  type PlannerTaskState,
} from "../../../planner/planner-contract";
import { classifyArtifact, type ArtifactClassification, type ArtifactGroupId } from "../../../export/artifact-classification";
import type { ExportedArtifact } from "../../../export/artifact-bundle";
import { DetailRow, formatTime } from "../shared";

const ARTIFACT_GROUP_ORDER: ArtifactGroupId[] = ["workspace", "planner", "simulation-inet", "manifest", "legacy"];

export const artifactGroupFallbackLabels: Record<ArtifactGroupId, string> = {
  workspace: "工作台展示",
  planner: "外部规划器",
  "simulation-inet": "INET 仿真输入",
  manifest: "清单",
  legacy: "旧版文件",
};

export function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: "switch" | "endSystem";
    portCount?: number;
    ipAddress?: string;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";
  return (
    <div className={`tsn-node ${nodeType}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">
        {nodeType === "switch" ? `${nodeData.portCount ?? 0} ports` : nodeData.ipAddress}
      </small>
    </div>
  );
}

export function PlannerTaskPanel({
  plannerRun,
  baseUrl,
  canStart,
  canStop,
  isActionRunning,
  onBaseUrlChange,
  onStart,
  onStop,
}: {
  plannerRun: PlannerRunState;
  baseUrl: string;
  canStart: boolean;
  canStop: boolean;
  isActionRunning: boolean;
  onBaseUrlChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const statusLabel = plannerStatusLabel(plannerRun.status);
  const elapsed = plannerRun.runningDurationMs === undefined
    ? undefined
    : `${Math.max(0, Math.round(plannerRun.runningDurationMs / 1000))} 秒`;

  return (
    <section className={`planner-task-panel ${plannerRun.status}`} aria-label="规划任务">
      <div className="planner-task-header">
        <div>
          <h3>规划任务</h3>
          <p>启动后会提交当前拓扑、流和规划默认参数，并持续等待规划服务返回结果。</p>
        </div>
        <span className={`planner-status ${plannerRun.status}`}>{statusLabel}</span>
      </div>
      <div className="planner-task-controls">
        <label htmlFor="planner-base-url">服务地址</label>
        <input
          id="planner-base-url"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          disabled={plannerRun.status === "running" || isActionRunning}
        />
        <button className="btn-primary" type="button" onClick={onStart} disabled={!canStart}>
          <RefreshCw size={14} aria-hidden="true" />
          启动规划
        </button>
        <button className="btn" type="button" onClick={onStop} disabled={!canStop}>
          <Square size={13} aria-hidden="true" />
          停止
        </button>
      </div>
      <div className="planner-task-grid">
        <DetailRow label="任务 ID" value={plannerRun.planId ?? "未提交"} />
        <DetailRow label="节点/链路/流" value={plannerRun.requestSummary
          ? `${plannerRun.requestSummary.nodeCount}/${plannerRun.requestSummary.linkCount}/${plannerRun.requestSummary.flowCount}`
          : "未生成"} />
        <DetailRow label="运行时长" value={elapsed ?? "未开始"} />
        <DetailRow label="最近更新" value={plannerRun.updatedAt ? formatTime(plannerRun.updatedAt) : "无"} />
      </div>
      {plannerRun.resultSummary && (
        <div className="planner-result-summary" role="status">
          <span>结果摘要</span>
          <strong>{plannerRun.resultSummary.linkCount} 条链路 · {plannerRun.resultSummary.gclEntryCount} 条 GCL</strong>
          <p>{plannerRun.resultSummary.fingerprintFiles.join(", ") || "无指纹文件"}</p>
        </div>
      )}
      {plannerRun.errorMessage && (
        <p className="planner-error" role="alert">
          {plannerRun.errorMessage}
        </p>
      )}
    </section>
  );
}

function plannerStatusLabel(status: PlannerTaskState): string {
  const labels: Record<PlannerTaskState, string> = {
    idle: "未提交",
    running: "运行中",
    succeeded: "已完成",
    failed: "失败",
    busy: "服务忙",
    cancel_requested: "取消中",
    cancelled: "已取消",
    no_running_plan: "无运行任务",
    not_found: "未找到",
    stale: "已失效",
    unknown: "未知",
  };
  return labels[status];
}

export function findPortIndex(node: { ports: Array<{ id: string; index: number }> }, portId: string): string | number {
  return node.ports.find((port) => port.id === portId)?.index ?? "无";
}

export function groupArtifacts(artifacts: ExportedArtifact[]) {
  const grouped = new Map<ArtifactGroupId, Array<{ artifact: ExportedArtifact; classification: ArtifactClassification }>>();

  for (const artifact of artifacts) {
    const classification = classifyArtifact(artifact);
    const artifactsForGroup = grouped.get(classification.group) ?? [];
    artifactsForGroup.push({ artifact, classification });
    grouped.set(classification.group, artifactsForGroup);
  }

  return ARTIFACT_GROUP_ORDER
    .map((groupId) => {
      const items = grouped.get(groupId) ?? [];
      return {
        id: groupId,
        label: items[0]?.classification.groupLabel ?? artifactGroupFallbackLabels[groupId],
        items,
      };
    })
    .filter((group) => group.items.length > 0);
}
