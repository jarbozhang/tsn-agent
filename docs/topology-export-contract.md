---
title: "拓扑导出契约（去 Qunee 新格式）"
type: contract
date: 2026-06-25
---

# 拓扑导出契约（去 Qunee 新格式）

`topology.build_artifacts`（Rust `build_topology_artifacts`，读内存 IntermediateTopology、不读库）从 2026-06-25（计划单元 U12）起只产一个干净的 `topology.json`，字段为 `mid/mac/ip/port`。**老的 Qunee 四件套（`topology.json` 的 imac 形态、`topo_feature.json`、`data-server.json`、`mac-forwarding-table.json`）以及 `imac`/`_classPath`/`sync_type`/`st_queues` 等遗留键全部移除，不再产出。**

旧导出文件与新格式不兼容。任何吃这份导出的外部工具（独立规划器、Qunee 编辑器）必须同步改吃新格式。

## 产出形状

```json
{
  "topology.json": {
    "name": "topology.json",
    "mediaType": "application/json",
    "byteLength": 0,
    "text": "...",
    "data": {
      "nodes": [
        {
          "mid": "0",
          "name": "SW-1",
          "mac": "02:00:00:00:00:00",
          "ip": "10.0.0.1",
          "portCount": 2,
          "queueCount": 3,
          "nodeType": "switch"
        }
      ],
      "links": [
        {
          "srcNode": "0",
          "dstNode": "1",
          "srcPort": 0,
          "dstPort": 0,
          "speed": 1000
        }
      ]
    }
  }
}
```

字段口径：

- `mid`：节点身份，等于 `numericId` 的字符串形式。连线端点 `srcNode`/`dstNode` 引用它。
- `name`：显示名（如 `SW-1`/`ES-1`）。
- `mac`：`02:` locally-administered 前缀，节点序号低 24 位；session 内确定性不重复。
- `ip`：`10.0.0.0/8` 私网，host 位 1..=254；session 内确定性不重复。
- `portCount`：节点端口数。
- `queueCount`：每节点 TSN 队列数，当前固定 3。
- `nodeType`：canonical 取值 `switch` / `endSystem` / `server`。
- 连线 `srcPort`/`dstPort`：端口序号整数（端口 `index`）。
- 连线 `speed`：链路速率 Mbps，等于 `dataRateMbps`。

节点按 `numericId` 升序、连线按 `numericId` 升序排序后输出，确定性可复现。

## 外部规划器风险

外部规划器是独立工具，其请求结构 `source_config.topo_feature`（见 `src/planner/planner-contract.ts` 的 `PlannerTopoFeature`：`link_id/src_node/src_port/dst_node/dst_port/speed/st_queues/macrotick`）由规划器自己组装，与本导出解耦——它不直接消费 `build_artifacts` 的产物。但 Qunee 编辑器 / 任何直接读这份导出的下游若仍按老 imac 形态解析，会读不到数据。

交付门控：本格式对外暴露前，须与规划器 / 下游维护方确认它们已能吃 `mid/mac/ip/port` 新格式（计划 U12「交付门控」），未对齐前通过独立 PR / feature flag 隔离，不阻塞拓扑/时钟同步其它阶段上线。
