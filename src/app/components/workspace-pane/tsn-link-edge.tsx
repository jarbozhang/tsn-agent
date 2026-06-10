import { BaseEdge, EdgeLabelRenderer, Position, type EdgeProps } from "@xyflow/react";
import type { TsnLinkEdgeData, TsnLinkGeometry } from "./topology-flow";

/**
 * Plan 2026-06-10-002 KTD：自定义正交折线 edge。getSmoothStepPath 的
 * offset/centerY 对同行直线与对角折线均不进路径（@xyflow/system getPoints
 * 的 verticalSplit / else 分支不消费 center 参数），故路径自建：
 * - cross：竖直下/上行 → 行间走廊横段（corridorOrd 决定走廊高度互异）→ 入目标；
 * - detour：水平出 stub → 向行外绕（rowDir × (44 + detourOrd × 14)）→ 回入目标；
 * - flat：直连。
 */
export interface TsnLinkPathParams {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  geometry: TsnLinkGeometry;
  corridorOrd: number;
  detourOrd: number;
  rowDir: 1 | -1;
}

export function buildTsnLinkPath(p: TsnLinkPathParams): string {
  if (p.geometry === "cross") {
    const corridorY = (p.sourceY + p.targetY) / 2 + p.corridorOrd * 12;
    return `M ${p.sourceX},${p.sourceY} L ${p.sourceX},${corridorY} L ${p.targetX},${corridorY} L ${p.targetX},${p.targetY}`;
  }

  if (p.geometry === "detour") {
    const stub = 16;
    const sox = p.sourceX + (p.sourcePosition === Position.Left ? -stub : stub);
    const tox = p.targetX + (p.targetPosition === Position.Left ? -stub : stub);
    const detourY = p.sourceY + p.rowDir * (44 + p.detourOrd * 14);
    return `M ${p.sourceX},${p.sourceY} L ${sox},${p.sourceY} L ${sox},${detourY} L ${tox},${detourY} L ${tox},${p.targetY} L ${p.targetX},${p.targetY}`;
  }

  return `M ${p.sourceX},${p.sourceY} L ${p.targetX},${p.targetY}`;
}

/** 端口标签锚点：贴近 handle、按本端 handle 序数沿轴错开，避免同 handle 标签互叠。 */
export function portLabelPoint(
  x: number,
  y: number,
  position: Position,
  ordinal: number,
): { x: number; y: number } {
  switch (position) {
    case Position.Top:
      return { x: x + 14 + ordinal * 16, y: y - 12 };
    case Position.Bottom:
      return { x: x + 14 + ordinal * 16, y: y + 12 };
    case Position.Left:
      return { x: x - 18, y: y - 11 - ordinal * 12 };
    default:
      return { x: x + 18, y: y - 11 - ordinal * 12 };
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

export function TsnLinkEdge(props: EdgeProps) {
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
  const path = buildTsnLinkPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    geometry: data.geometry ?? "flat",
    corridorOrd: data.corridorOrd ?? 0,
    detourOrd: data.detourOrd ?? 0,
    rowDir: data.rowDir ?? 1,
  });
  const left = data.leftLabel
    ? portLabelPoint(sourceX, sourceY, sourcePosition, data.srcOrd ?? 0)
    : undefined;
  const right = data.rightLabel
    ? portLabelPoint(targetX, targetY, targetPosition, data.dstOrd ?? 0)
    : undefined;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {left && data.leftLabel && <PortLabel x={left.x} y={left.y} text={data.leftLabel} />}
      {right && data.rightLabel && <PortLabel x={right.x} y={right.y} text={data.rightLabel} />}
    </>
  );
}
