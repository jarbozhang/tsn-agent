/**
 * Plan v3 Phase B-β (PR-β1)：`query_topology` Tauri command 返回值的 TS 镜像。
 *
 * sidecar 写 P0 表（topology_nodes / topology_links）是唯一权威，UI 读路径
 * 通过 `invoke("query_topology")` 拉本快照渲染 React Flow。
 * 字段与 src-tauri/src/topology_query_command.rs 的 serde camelCase 输出一一对应。
 */

export interface TopologyRowSnapshot {
  sessionId: string;
  nodes: TopologyNodeRow[];
  links: TopologyLinkRow[];
}

export interface TopologyNodeRow {
  /** 节点逻辑序号：节点身份 / 画布 id / 选中键。 */
  mid: string;
  /** 逻辑节点名（如 ES-1），initialize 写入；缺失时画布回退派生名。 */
  name: string | null;
  x: number;
  y: number;
  nodeType: string | null;
  insertOrder: number;
}

export interface TopologyLinkRow {
  linkSeq: number;
  name: string | null;
  srcNode: string;
  dstNode: string;
  /** U8/KTD1：端口列是事实源（src 端口在 source 端、dst 端口在 target 端）；NULL=未配对。 */
  srcPort: number | null;
  dstPort: number | null;
  stylesJson: string;
}

export function countSwitches(snapshot: TopologyRowSnapshot): number {
  return snapshot.nodes.filter((node) => node.nodeType === "switch").length;
}

export function countEndSystems(snapshot: TopologyRowSnapshot): number {
  return snapshot.nodes.length - countSwitches(snapshot);
}

export function isEmptyTopologySnapshot(snapshot: TopologyRowSnapshot | undefined): boolean {
  return !snapshot || (snapshot.nodes.length === 0 && snapshot.links.length === 0);
}
