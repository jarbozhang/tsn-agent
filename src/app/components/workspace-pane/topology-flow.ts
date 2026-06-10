import type { Edge, Node } from "@xyflow/react";
import type { TopologyLinkRow, TopologyNodeRow, TopologyRowSnapshot } from "../../../sessions/topology-snapshot";

/**
 * Plan 2026-06-10-002：DB 快照 → React Flow 的纯函数映射层。
 * 节点 x/y 的唯一权威在 Rust 生成端；这里只做对坐标的确定性纯函数推导
 * （handle 选边、走廊/绕行序数、平面 className），不读写坐标。
 */

/** 与 @xyflow Position 同值但独立定义——映射层保持纯函数、不依赖 React Flow 运行时。 */
export type HandleSide = "top" | "bottom" | "left" | "right";

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

/**
 * 边几何三态（R12，KTD：getSmoothStepPath 的 offset/centerY 对本布局的
 * 同行直线与对角折线均不生效，路径由 TsnLinkEdge 自建正交折线）：
 * - cross：跨行边，横段走「行间走廊」，corridorOrd 决定走廊高度互异；
 * - flat：同行直连（无遮挡、同 handle 首条）；
 * - detour：同行绕行（有节点遮挡或同 handle 堆叠），rowDir 决定向行外哪侧绕。
 */
export type TsnLinkGeometry = "cross" | "flat" | "detour";

export interface TsnLinkEdgeData {
  geometry: TsnLinkGeometry;
  /** 同 handle 序数（linkSeq 升序）——端口标签沿轴错开用。 */
  srcOrd: number;
  dstOrd: number;
  /** cross：同一对行（走廊）内的序数，横段高度 = 行中点 + ord × 12。 */
  corridorOrd: number;
  /** detour：同行绕行序数，深度 = 44 + ord × 14。 */
  detourOrd: number;
  /** detour 方向：-1 向上（行带处于画布上半部时向外绕）。 */
  rowDir: 1 | -1;
  leftLabel?: string;
  rightLabel?: string;
  /** React Flow Edge.data 的结构性要求；不影响已命名字段的类型推断。 */
  [key: string]: unknown;
}

function bumpCursor(cursor: Map<string, number>, key: string): number {
  const value = cursor.get(key) ?? 0;
  cursor.set(key, value + 1);
  return value;
}

/** 行带在画布上半部 → 向上绕行（外侧），否则向下。 */
function rowDirection(nodes: TopologyNodeRow[], y: number): 1 | -1 {
  let min = Infinity;
  let max = -Infinity;
  for (const node of nodes) {
    min = Math.min(min, node.y);
    max = Math.max(max, node.y);
  }
  return y <= (min + max) / 2 ? -1 : 1;
}

export function topologySnapshotToReactFlow(snapshot: TopologyRowSnapshot): { nodes: Node[]; edges: Edge[] } {
  const nodeByImac = new Map(snapshot.nodes.map((node) => [node.imac, node]));
  const sortedLinks = [...snapshot.links].sort((a, b) => a.linkSeq - b.linkSeq);
  const handleCursor = new Map<string, number>();
  const corridorCursor = new Map<string, number>();

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
      const srcOrd = bumpCursor(handleCursor, `${link.srcImac}:${sides.source}`);
      const dstOrd = bumpCursor(handleCursor, `${link.dstImac}:${sides.target}`);

      let geometry: TsnLinkGeometry = "flat";
      let corridorOrd = 0;
      let detourOrd = 0;
      let rowDir: 1 | -1 = 1;
      if (source && target) {
        if (source.y !== target.y) {
          geometry = "cross";
          const lo = Math.min(source.y, target.y);
          const hi = Math.max(source.y, target.y);
          corridorOrd = bumpCursor(corridorCursor, `cross:${lo}:${hi}`);
        } else {
          const left = Math.min(source.x, target.x);
          const right = Math.max(source.x, target.x);
          const blocked = snapshot.nodes.some(
            (node) =>
              node.imac !== link.srcImac &&
              node.imac !== link.dstImac &&
              node.y === source.y &&
              node.x > left &&
              node.x < right,
          );
          if (blocked || srcOrd > 0 || dstOrd > 0) {
            geometry = "detour";
            rowDir = rowDirection(snapshot.nodes, source.y);
            detourOrd = bumpCursor(corridorCursor, `detour:${source.y}:${rowDir}`);
          }
        }
      }

      const data: TsnLinkEdgeData = {
        geometry,
        srcOrd,
        dstOrd,
        corridorOrd,
        detourOrd,
        rowDir,
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

export function linkRowId(link: TopologyLinkRow): string {
  return `link-${link.linkSeq}`;
}
