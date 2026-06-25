---
title: LinkAdd 增量改图漏填端口独立列，导致新增节点进不了时钟树
date: 2026-06-25
category: database-issues
module: timesync
problem_type: database_issue
component: database
symptoms:
  - "时钟同步阶段经大模型回拓扑新增 ES-5 后再返回，ES-5 进了 timesync_nodes 表但 master/slave 时钟端口全空 []，加不进时钟树"
  - "实库铁证：新链路 src_port/dst_port 列为 NULL，而同行 styles_json 里 leftLabel/rightLabel 有值；对应 timesync_nodes 角色数组全 []"
  - "compute_clock_tree 的 BFS 能 reach 到新节点，但 inc.local_port 为 NULL，if let Some(port) 跳过角色分配"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - topology_ops
  - timesync_tree
  - topology_sidecar_routes
tags: [timesync, clock-tree, link-add, port-columns, styles-json, null-column, dual-write-path]
---

# LinkAdd 增量改图漏填端口独立列，导致新增节点进不了时钟树

## Problem

stage2 时钟同步特性把链路的 `src_port`/`dst_port`/`speed` 从 `topology_links.styles_json` 拆成表的**独立列**，`compute_clock_tree` 改读这三个独立列来分配 master/slave 时钟角色。但只更新了 initialize 写入路径（`persist_initialized_topology`），漏改了增量改图路径 `TopologyOp::LinkAdd`——它的 INSERT 从不写这三列，导致 agent 在拓扑阶段新增节点的链路这三列恒为 NULL。

## Symptoms

- 时钟同步阶段 → 经大模型回拓扑阶段加 ES-5 节点 → 回时钟同步：ES-5 进了 `timesync_nodes` 表，但 master/slave 端口全空，加不进时钟树（无报错）。
- 实库铁证：新链路（link 10/11）`src_port`/`dst_port` = NULL，但同行 `styles_json` 里 `leftLabel:P0/P1`、`rightLabel:P3` 都在；对应 `timesync_nodes` mid 8 的角色集合全为 `[]`。

## What Didn't Work

排除的调查方向（每个都是「症状像、根因不是」）：

- **怀疑 `set_gm` 幂等空跑没触发重算** → 实为 `set_gm` 每次都 `recompute_and_persist`，重算确实跑了（所以 ES-5 才会进 `timesync_nodes`）。
- **怀疑 `compute_clock_tree` 的 BFS 算法有 bug** → 算法没问题，是喂进去的列就是 NULL。
- **怀疑 ES-5 没被 BFS reach 到** → BFS 正常 reach 到了，只是该节点树边的 `local_port=NULL`，角色分配的 `if let Some(port)` 守卫直接跳过——节点进了树遍历但端口一个没分到。

放大症状的两处守卫（`src-tauri/src/timesync_tree.rs`，`local_port` 来自 `SELECT ... src_port, dst_port FROM topology_links`，列为 NULL 时 `Option<i64>` = `None`）：

```rust
if let Some(port) = inc.local_port {        // 树边 node 侧 = master
    master.get_mut(&node).unwrap().insert(port);
    tree_ports.insert((node.clone(), port));
}
if let Some(port) = child_port {            // neighbor 侧 = slave
    slave.get_mut(&inc.neighbor).unwrap().insert(port);
    tree_ports.insert((inc.neighbor.clone(), port));
}
```

## Solution

`src-tauri/src/topology_ops.rs` 的 `TopologyOp::LinkAdd` handler，复用已有的 `db::parse_link_ports_and_speed` 把 `styles_json` 的 `leftLabel`/`rightLabel`/`speed` 解析进独立列，与 initialize 路径同源。

**Before**：

```rust
let res = sqlx::query(
    r#"INSERT INTO topology_links
       (session_id, link_seq, name, src_node, dst_node, styles_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, link_seq) DO NOTHING"#,
)
.bind(session_id).bind(a.link_seq).bind(&a.name)
.bind(&a.src_node).bind(&a.dst_node).bind(&a.styles_json)
```

**After**：

```rust
// 端口/速率从 styles_json 的 leftLabel/rightLabel/speed 解析进独立列——
// 与 initialize 路径同源（compute_clock_tree 读这些列分配时钟角色）。
let (src_port, dst_port, speed) = crate::db::parse_link_ports_and_speed(&a.styles_json);
let res = sqlx::query(
    r#"INSERT INTO topology_links
       (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, link_seq) DO NOTHING"#,
)
.bind(session_id).bind(a.link_seq).bind(&a.name)
.bind(&a.src_node).bind(&a.dst_node)
.bind(src_port).bind(dst_port).bind(speed).bind(&a.styles_json)
```

`parse_link_ports_and_speed`（`src-tauri/src/db.rs`）即 initialize 路径同款解析：`leftLabel`→`src_port`、`rightLabel`→`dst_port`、`speed`→`speed`，端口标签经 `parse_port_label` 提取（`"P2"`→2、`"1"`→1，非数字→None）。

> 已存在的坏会话旧链路仍为 NULL（不自动回填），重连一次该链路即修复。

## Why This Works

- 独立列 `src_port`/`dst_port` 是 `compute_clock_tree` 分配时钟角色的**唯一依据**——它只 `SELECT ... src_port, dst_port`，根本不读 `styles_json`。（Qunee/规划器导出走 `build_artifacts` 读 `styles_json`，不读这些列，所以症状只在时钟树暴露。）
- `styles_json` 一直带着 `leftLabel`/`rightLabel`/`speed`，信息从未丢，只是增量路径没把它**解析进列**。
- 补上 `parse_link_ports_and_speed` 后，`LinkAdd` 与 `persist_initialized_topology` 走同一套「styles 标签 → 独立列」逻辑，两条写表路径对齐，列不再 NULL，BFS 守卫正常命中。

## Prevention

1. **拆列/拆字段重构时，审计「所有写该表的路径」而非只改一处。** 本 bug 根因就是 stage2 拆列只改了 initialize，漏了 LinkAdd 增量路径。`grep "INSERT INTO topology_links"` 列全量写入点逐一核对。
2. **测试要断言独立列，不能只断言 `styles_json`。** 现有 link_add 测试只验 `styles_json` 三态写入、从不断言 `src_port`/`dst_port`/`speed` 列——这正是放过 bug 的盲区。test-first 回归 `link_add_populates_port_columns_from_styles_json` 直接断言解析后的列：

   ```rust
   // 输入 styles_json = {"leftLabel":"P2","rightLabel":"P3","speed":1000}
   assert_eq!(row.get::<Option<i64>, _>("src_port"), Some(2), "leftLabel P2 → src_port 2");
   assert_eq!(row.get::<Option<i64>, _>("dst_port"), Some(3), "rightLabel P3 → dst_port 3");
   assert_eq!(row.get::<Option<i64>, _>("speed"), Some(1000));
   ```

3. **可考虑统一 link 写入走单一 helper。** initialize 与 LinkAdd 各写一份几乎相同的 INSERT + 同一个 `parse_*`，是这类「改一处漏一处」的温床；抽一个 `insert_topology_link(...)` 让两条路径共用，可从结构上杜绝再次漂移。

## Related Issues

- PR #55 `fix(topology): link.add 漏填端口列导致新增节点进不了时钟树`（commit `3fefb83`，2026-06-25 merged）。
- 同源 stage2 列拆分背景见 memory `topology-dequnee-imac-rekey-status`（节点身份改 mid、连线端点改 src/dst_node）——该轮拆出独立列时未记录「独立列须在所有写链路同源填充」这一隐患，本 bug 即其实证。
