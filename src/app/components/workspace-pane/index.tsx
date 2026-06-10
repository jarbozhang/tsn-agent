import { Fragment, useMemo } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  countEndSystems,
  countSwitches,
  isEmptyTopologySnapshot,
  type TopologyLinkRow,
  type TopologyNodeRow,
  type TopologyRowSnapshot,
} from "../../../sessions/topology-snapshot";
import { DetailRow, Stat } from "../shared";

export type ConfigTabId = "node-detail" | "link-detail";

export type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
];

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

const edgeTypes = {
  tsnLink: TsnLinkEdge,
};

export interface WorkspacePaneProps {
  topologySnapshot: TopologyRowSnapshot | undefined;
  selectedTopologyItem: SelectedTopologyItem | undefined;
  activeConfigTab: ConfigTabId;
  isAgentRunning: boolean;
  hasUserInteraction: boolean;
  onSelectConfigTab: (tab: ConfigTabId) => void;
  onNodeSelect: (event: unknown, node: Node) => void;
  onLinkSelect: (event: unknown, edge: Edge) => void;
}

export function WorkspacePane({
  topologySnapshot,
  selectedTopologyItem,
  activeConfigTab,
  isAgentRunning,
  hasUserInteraction,
  onSelectConfigTab,
  onNodeSelect,
  onLinkSelect,
}: WorkspacePaneProps) {
  const flowTopology = useMemo(
    () => (topologySnapshot && !isEmptyTopologySnapshot(topologySnapshot)
      ? topologySnapshotToReactFlow(topologySnapshot)
      : undefined),
    [topologySnapshot],
  );
  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);
  const switchCount = topologySnapshot ? countSwitches(topologySnapshot) : 0;
  const endSystemCount = topologySnapshot ? countEndSystems(topologySnapshot) : 0;
  const linkCount = topologySnapshot?.links.length ?? 0;
  const selectedNode = selectedTopologyItem?.kind === "node"
    ? topologySnapshot?.nodes.find((node) => String(node.imac) === selectedTopologyItem.id)
    : undefined;
  const selectedLink = selectedTopologyItem?.kind === "link"
    ? topologySnapshot?.links.find((link) => linkRowId(link) === selectedTopologyItem.id)
    : undefined;
  const selectedLinkSourceNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.imac === selectedLink.srcImac)
    : undefined;
  const selectedLinkTargetNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.imac === selectedLink.dstImac)
    : undefined;

  return (
    <section className="workspace-pane" aria-label="工程状态">
      <div className="topology-stage grid-bg">
        <div className="topology-meta mono">TSN PROJECT DB · REACT FLOW</div>
        <div className="topology-stats" aria-label="拓扑统计">
          <Stat label="交换机" value={switchCount} />
          <Stat label="端系统" value={endSystemCount} />
          <Stat label="链路" value={linkCount} />
        </div>
        <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
          {flowTopology ? (
            <ReactFlow
              nodes={flowTopology.nodes}
              edges={flowTopology.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              nodesDraggable={false}
              onNodeClick={onNodeSelect}
              onEdgeClick={onLinkSelect}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="topology-empty mono">
              {isAgentRunning
                ? "正在生成拓扑图"
                : hasUserInteraction
                  ? "拓扑生成后在这里显示"
                  : "描述你的 TSN 需求后生成拓扑图"}
            </div>
          )}
        </div>
      </div>

      <div className="config-panel">
        <div className="config-tabs" role="tablist" aria-label="工程详情">
          {CONFIG_TABS.map((tab) => (
            <button
              className={activeConfigTab === tab.id ? "config-tab active" : "config-tab"}
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeConfigTab === tab.id}
              aria-controls={`config-panel-${tab.id}`}
              id={`config-tab-${tab.id}`}
              onClick={() => onSelectConfigTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          <div className="config-spacer" />
          <span className="config-state mono">配置 · {hasTopology ? "草案" : "未生成"}</span>
        </div>

        <div className="config-body">
          {activeConfigTab === "node-detail" && (
            <section
              className="detail-panel"
              id="config-panel-node-detail"
              role="tabpanel"
              aria-label="节点详情"
            >
            <div className="panel-heading">
              <div>
                <h2>节点详情</h2>
                <p>{selectedNode ? nodeRowLabel(selectedNode) : "在拓扑画布选择一个节点查看类型、地址和位置。"}</p>
              </div>
            </div>
            {selectedNode ? (
              <div className="detail-grid">
                <DetailRow label="名称" value={selectedNode.name ?? "无"} />
                <DetailRow label="IMAC" value={selectedNode.imac} />
                <DetailRow label="同步名称" value={selectedNode.syncName} />
                <DetailRow label="类型" value={selectedNode.nodeType === "switch" ? "交换机" : "端系统"} />
                <DetailRow label="坐标" value={`${selectedNode.x}, ${selectedNode.y}`} />
                <DetailRow label="插入顺序" value={selectedNode.insertOrder} />
              </div>
            ) : (
              <div className="empty-panel mono">请选择拓扑画布中的节点</div>
            )}
          </section>
          )}

          {activeConfigTab === "link-detail" && (
            <section
              className="detail-panel"
              id="config-panel-link-detail"
              role="tabpanel"
              aria-label="链路详情"
            >
            <div className="panel-heading">
              <div>
                <h2>链路详情</h2>
                <p>{selectedLink ? linkRowId(selectedLink) : "在拓扑画布选择一条链路查看端点。"}</p>
              </div>
            </div>
            {selectedLink ? (
              <div className="detail-grid">
                <DetailRow label="链路序号" value={selectedLink.linkSeq} />
                <DetailRow label="名称" value={selectedLink.name ?? "无"} />
                <DetailRow
                  label="源端点"
                  value={selectedLinkSourceNode ? nodeRowLabel(selectedLinkSourceNode) : `imac ${selectedLink.srcImac}`}
                />
                <DetailRow
                  label="目标端点"
                  value={selectedLinkTargetNode ? nodeRowLabel(selectedLinkTargetNode) : `imac ${selectedLink.dstImac}`}
                />
              </div>
            ) : (
              <div className="empty-panel mono">请选择拓扑画布中的链路</div>
            )}
          </section>
          )}
        </div>
      </div>
    </section>
  );
}

type HandleSide = "top" | "bottom" | "left" | "right";

export interface LinkStyleMeta {
  plane?: "A" | "B";
  leftLabel?: string;
  rightLabel?: string;
}

/** R7：stylesJson 容错解析——缺失、非法值、解析失败一律回退空 meta（中性渲染），不抛错。 */
export function parseLinkStyles(stylesJson: string): LinkStyleMeta {
  try {
    const parsed: unknown = JSON.parse(stylesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    const meta: LinkStyleMeta = {};
    if (record.plane === "A" || record.plane === "B") {
      meta.plane = record.plane;
    }
    if (typeof record.leftLabel === "string" && record.leftLabel !== "") {
      meta.leftLabel = record.leftLabel;
    }
    if (typeof record.rightLabel === "string" && record.rightLabel !== "") {
      meta.rightLabel = record.rightLabel;
    }
    return meta;
  } catch {
    return {};
  }
}

/** R9：平面配色走 className（CSS 级联保证选中态 --accent 优先），不用 inline stroke。 */
export function planeClassName(plane: LinkStyleMeta["plane"]): string {
  if (plane === "A") {
    return "plane-a";
  }
  if (plane === "B") {
    return "plane-b";
  }
  return "plane-neutral";
}

/** R10：跨行（y 不同）一律垂直 handle、同行水平——两端 DB 坐标的纯函数。 */
export function pickHandleSides(
  source: Pick<TopologyNodeRow, "x" | "y">,
  target: Pick<TopologyNodeRow, "x" | "y">,
): { source: HandleSide; target: HandleSide } {
  if (source.y === target.y) {
    return source.x <= target.x
      ? { source: "right", target: "left" }
      : { source: "left", target: "right" };
  }

  return source.y < target.y
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

export interface TsnLinkEdgeData {
  /** R12：同 handle 边的 smoothstep 转弯距离（基准 20 + 序数 × 12）。 */
  offset: number;
  /** 同 handle 序数（按 linkSeq 升序），端口标签横向错开用。 */
  stackIndex: number;
  /** 同行共走廊边的绕行位移（offset 对同 y 直线无效，KTD）；0 = 直连。 */
  centerYShift: number;
  leftLabel?: string;
  rightLabel?: string;
  [key: string]: unknown;
}

function bumpCursor(cursor: Map<string, number>, key: string): number {
  const value = cursor.get(key) ?? 0;
  cursor.set(key, value + 1);
  return value;
}

export function topologySnapshotToReactFlow(snapshot: TopologyRowSnapshot): { nodes: Node[]; edges: Edge[] } {
  const nodeByImac = new Map(snapshot.nodes.map((node) => [node.imac, node]));
  const sortedLinks = [...snapshot.links].sort((a, b) => a.linkSeq - b.linkSeq);
  const handleCursor = new Map<string, number>();

  return {
    nodes: snapshot.nodes.map((node) => ({
      id: String(node.imac),
      type: "tsnNode",
      position: { x: node.x, y: node.y },
      data: {
        label: nodeRowLabel(node),
        nodeType: node.nodeType === "switch" ? "switch" : "endSystem",
        imac: node.imac,
      },
    })),
    edges: sortedLinks.map((link) => {
      const source = nodeByImac.get(link.srcImac);
      const target = nodeByImac.get(link.dstImac);
      const meta = parseLinkStyles(link.stylesJson);
      const sides =
        source && target
          ? pickHandleSides(source, target)
          : { source: "right" as HandleSide, target: "left" as HandleSide };
      const stackIndex = Math.max(
        bumpCursor(handleCursor, `${link.srcImac}:${sides.source}`),
        bumpCursor(handleCursor, `${link.dstImac}:${sides.target}`),
      );
      const sameRow = source !== undefined && target !== undefined && source.y === target.y;
      const data: TsnLinkEdgeData = {
        offset: 20 + stackIndex * 12,
        stackIndex,
        centerYShift: sameRow && stackIndex > 0 ? 44 + (stackIndex - 1) * 14 : 0,
        leftLabel: meta.leftLabel,
        rightLabel: meta.rightLabel,
      };
      return {
        id: linkRowId(link),
        source: String(link.srcImac),
        target: String(link.dstImac),
        sourceHandle: `s-${sides.source}`,
        targetHandle: `t-${sides.target}`,
        type: "tsnLink",
        className: planeClassName(meta.plane),
        data,
      };
    }),
  };
}

/** 画布标签：优先逻辑名（与 agent 对话命名一致），缺失回退「前缀-同步名」派生。 */
export function nodeRowLabel(node: TopologyNodeRow): string {
  if (node.name) {
    return node.name;
  }

  const prefix = node.nodeType === "switch" ? "SW" : "ES";
  return `${prefix}-${node.syncName}`;
}

function linkRowId(link: TopologyLinkRow): string {
  return `link-${link.linkSeq}`;
}

const HANDLE_SIDES: Array<[HandleSide, Position]> = [
  ["top", Position.Top],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
  ["right", Position.Right],
];

function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: "switch" | "endSystem";
    imac?: number;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";

  return (
    <div className={`tsn-node ${nodeType}`}>
      {HANDLE_SIDES.map(([side, position]) => (
        <Fragment key={side}>
          <Handle id={`s-${side}`} type="source" position={position} />
          <Handle id={`t-${side}`} type="target" position={position} />
        </Fragment>
      ))}
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">imac {nodeData.imac}</small>
    </div>
  );
}

/** 端口标签锚点：贴近 handle、沿 R12 偏移同轴错开，避免同 handle 标签互叠。 */
function portLabelPoint(
  x: number,
  y: number,
  position: Position,
  stackIndex: number,
): { x: number; y: number } {
  switch (position) {
    case Position.Top:
      return { x: x + 14 + stackIndex * 16, y: y - 12 };
    case Position.Bottom:
      return { x: x + 14 + stackIndex * 16, y: y + 12 };
    case Position.Left:
      return { x: x - 18, y: y - 11 - stackIndex * 12 };
    default:
      return { x: x + 18, y: y - 11 - stackIndex * 12 };
  }
}

function PortLabel({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <EdgeLabelRenderer>
      <div
        className="tsn-port-label mono nodrag nopan"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

/**
 * Plan 2026-06-10-002 KTD：thin custom edge——内部仍走 getSmoothStepPath（保
 * smoothstep 形态与 offset），加双端端口标签；同行共走廊边用 centerY 位移绕行
 * （offset 参数对同 y 直线无效）。
 */
function TsnLinkEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    style,
  } = props;
  const data = (props.data ?? {}) as Partial<TsnLinkEdgeData>;
  const stackIndex = data.stackIndex ?? 0;
  const centerYShift = data.centerYShift ?? 0;
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 6,
    offset: data.offset ?? 20,
    ...(centerYShift !== 0 ? { centerY: (sourceY + targetY) / 2 + centerYShift } : {}),
  });
  const left = data.leftLabel
    ? portLabelPoint(sourceX, sourceY, sourcePosition, stackIndex)
    : undefined;
  const right = data.rightLabel
    ? portLabelPoint(targetX, targetY, targetPosition, stackIndex)
    : undefined;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {left && data.leftLabel && <PortLabel x={left.x} y={left.y} text={data.leftLabel} />}
      {right && data.rightLabel && <PortLabel x={right.x} y={right.y} text={data.rightLabel} />}
    </>
  );
}
