import type { Edge, Node } from "@xyflow/react";
import type { TopologyLinkRow, TopologyNodeRow, TopologyRowSnapshot } from "../../../sessions/topology-snapshot";

/**
 * Plan 2026-06-11-001：DB 快照 → React Flow 的纯函数映射层。
 * 节点 x/y 的权威在数据库（生成端写入 + 用户拖动经 update_node_position 写回）；
 * 边几何由 TsnFloatingEdge 按节点实时位置动态计算，映射层不再做 handle 选边。
 */

export interface LinkStyleMeta {
  plane?: "A" | "B";
  leftLabel?: string;
  rightLabel?: string;
}

/** R7（origin 2026-06-10）：stylesJson 容错解析——缺失、非法值、解析失败一律回退空 meta，不抛错。 */
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

/** R3：平面配色走 className（CSS 级联保证选中态 --accent 优先），不用 inline stroke。 */
export function planeClassName(plane: LinkStyleMeta["plane"]): string {
  if (plane === "A") {
    return "plane-a";
  }
  if (plane === "B") {
    return "plane-b";
  }
  return "plane-neutral";
}

export interface TsnEdgeData {
  leftLabel?: string;
  rightLabel?: string;
  /** React Flow Edge.data 的结构性要求；不影响已命名字段的类型推断。 */
  [key: string]: unknown;
}

export function topologySnapshotToReactFlow(snapshot: TopologyRowSnapshot): { nodes: Node[]; edges: Edge[] } {
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
    edges: snapshot.links.map((link) => {
      const meta = parseLinkStyles(link.stylesJson);
      const data: TsnEdgeData = {
        leftLabel: meta.leftLabel,
        rightLabel: meta.rightLabel,
      };
      return {
        id: linkRowId(link),
        source: String(link.srcImac),
        target: String(link.dstImac),
        type: "tsnFloating",
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

export function linkRowId(link: TopologyLinkRow): string {
  return `link-${link.linkSeq}`;
}
