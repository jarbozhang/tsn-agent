---
date: 2026-06-17
type: refactor
title: "refactor: 拓扑去 Qunee 化 —— imac 改逻辑序号键、删 sync_type"
status: ready
depth: deep
---

# refactor: 拓扑去 Qunee 化（imac → 逻辑序号键，删除 sync_type）

> 给 boss 的一句话说明：现在数据库里给每个网络节点存了两样**只有 Qunee 画图软件才用得到**的东西——一个大数字编号 `imac`、一个画图类名 `sync_type`。我们以后不用 Qunee 了，规划器认的是逻辑序号（0/1/2…）。这次把节点的"身份证"从大数字 `imac` 换成逻辑序号，并删掉画图类名；Qunee 格式在万一需要时仍能从节点和连线现场导出（不必存库）。你本机已有的工程会在下次打开时自动平滑升级。

---

## Summary

数据库的拓扑节点目前用 Qunee 遗留的大数字 `imac`（如 360，当前合成为 `100+insert_order`）作主键，连线两端 `src_imac`/`dst_imac` 也引用它；并存了一列 Qunee 画图类名 `sync_type`（`{"_classPath":"Q.Graphs.exchanger2"}`）。经核实（见 Sources）：**规划器与 MAC 转发表只认逻辑序号 `sync_name`（0/1/2/8），从不使用 `imac` 或 `sync_type`**；`sync_type` 还是从 `node_type` 现算的冗余存储；Qunee/规划器导出走的 `build_artifacts` 读的是请求体里的内存拓扑、**不读库**，所以"现导"能力与 DB 主键无关。

本次重构把节点身份从 `imac` 改为 `sync_name`（每会话唯一），连线两端改引用 `sync_name`，删除 `sync_type` 列，并同步收口写入/查询/前端/MCP 工具/SKILL 指引/导入导出，及一条把现有库平滑升级的数据迁移。单路径、不保留新旧双轨。

---

## Problem Frame

**现状的问题**：库里混存了两套节点标识体系——Qunee 渲染体系（`imac` 大数字 + `sync_type` 画图类名）与规划器体系（`sync_name` 逻辑序号）。前者在"不再用 Qunee"的前提下是纯遗留负担：

- `imac` 是 Qunee 画布节点 id；规划器输入 `topo_feature.json` 用 `src_node/dst_node`=逻辑序号、`node.json` 以 `"0"/"1"/"2"` 为键、`static_mac_cfg.json` 以逻辑序号标识，全不碰 imac。
- `sync_type._classPath` 纯 Qunee 渲染用，且由 `node_type` 经 `legacy_class_path()` 现算，存库冗余。
- `imac` 还意外地"溢出"成了前端的用户可见字段、React Flow 节点 id、选中 id、位置提交键——遗留概念渗进了 UI。

**为什么现在做**：与同期"拓扑阶段 INET 验证"同源（验证要把库内拓扑喂给外部引擎，库越贴近规划器真实模型越省事）；且趁 `planning-export` 尚未落地、字段约定还便宜时收口。

**不解决会怎样**：每加一处消费（验证、真机导出）都要先认两套 id、再做 imac↔序号转换，遗留概念持续扩散。

---

## Requirements

- **R1** 节点在数据库中的稳定身份改为 `sync_name`（逻辑序号），每会话唯一；不再以 `imac` 作主键。
- **R2** 连线两端改为引用节点的 `sync_name`，不再引用 `imac`。
- **R3** 删除 `topology_nodes.sync_type` 列；写入/查询/对账/导入导出全链路不再涉及它。
- **R4** Qunee/规划器格式（`topology.json` 等）在确需导出时，仍能从"节点 + node_type + 连线"现场导出（`imac`、`_classPath` 现算，不落库）。此能力保持可用。
- **R5** 现有用户库（含 boss 本机）在下次启动时自动迁移：用每行已存的 `sync_name` 作新键、把连线端点从 imac 重映射为 sync_name、删除 `sync_type` 列；不丢节点/连线/位置。
- **R6** MCP 工具 schema 与 `.claude/skills/tsn-topology/SKILL.md` 指引同步更新：节点键改用 `sync_name`、移除"照抄 syncType 原文"一类指引，避免 agent 按旧字段乱填。
- **R7** 前端不再显示/依赖 `imac`；节点身份与画布 id 改用 `sync_name`（用户可见处展示逻辑序号）。
- **R8** 单路径实现，不保留 imac/sync_type 的兼容双轨。旧的"已导出会话文件"在本次后不再可导入（见 Scope Boundaries，已与 boss 确认接受）。

---

## Key Technical Decisions

### KTD1：新节点键 = `sync_name`（每会话唯一），不是 `insert_order`
规划器/ MAC 表的节点身份就是 `sync_name`（0/1/2/8）。`insert_order` 是展示排序、语义是"位置"不是"身份"。选 `sync_name` 让库内身份与规划器、与前端 React Flow 的 `String(id)` 字符串契约都对齐。`insert_order` 保留为展示排序列（非键）。新 PK = `(session_id, sync_name)`，并对 `node_add` 强制唯一（`IMAC_TAKEN` → `SYNC_NAME_TAKEN`）。

### KTD2：删除 `sync_type` 列，Qunee 类名改"现导"
`sync_type._classPath` 由 `node_type` 经 `legacy_class_path()` 现算（topology_compute.rs:2220），存库纯冗余。删列；需要 Qunee 格式时由 `build_legacy_topology_json`（topology_compute.rs:2247）现算——该路径读请求体内存拓扑、不读库，**本次无需改动**，只需验证其输出仍含合法 imac/_classPath（R4）。

### KTD3：迁移用"表重建"，键源是每行已存的 `sync_name`
改主键属 SQLite PK 变更，须建新表 → `INSERT…SELECT` → 删旧 → 改名（不能简单 `ALTER`）。关键利好：**`sync_name` 已存在于每一行**，迁移只是把它"扶正"为键、把连线端点用 `imac→sync_name` 映射改写、并丢弃 `imac`/`sync_type` 两列——无数据损失。作为 `migrations()` 的 v6（当前到 v5）。`topology_links` 与 `topology_nodes` **无 FK**（仅 `session_id→sessions`），但两表须在同一事务内一致改写。边界：极少数情况下历史 `node_add` 可能产生重复 `sync_name`（旧 schema 无唯一约束）——迁移须探测并修复（去重重排），否则违反新 PK。

### KTD4：`node_add` 由 agent 分配 `sync_name`（沿用既有"键由调用方给、重试重发同键"语义）
保持现有 inspect→拿键→node_add 的幂等/重试模型，只是键从 `imac` 换成 `sync_name`。比"后端自动分配序号"改动小、且不破坏重试需重发同键的契约。

### KTD5：链路端点列改名 `src_imac`/`dst_imac` → `src_sync_name`/`dst_sync_name`
列值即 `sync_name`，列名同步改清楚，避免"叫 imac 实为序号"的二次误导。`SESSION_SCOPED_TABLES`（导入导出列清单）同步改。

### KTD6：旧"已导出会话文件"不再兼容，接受不做双轨
导入是按 `SESSION_SCOPED_TABLES` 逐列原样拷贝；列清单一改，旧导出的 `.db`（含大数字 imac/sync_type）无法原样导入，且无 imac→sync_name 翻译钩子。按项目"单路径不双轨"原则与 boss 确认：放弃旧导出文件兼容。boss 本机的**当前活动库**走 R5 自动迁移、不受影响。

---

## High-Level Technical Design

### 数据模型 before / after

```
BEFORE                                  AFTER
topology_nodes                          topology_nodes
  PK (session_id, imac)                   PK (session_id, sync_name)
  imac        INTEGER  ← Qunee 大数字       (imac 列删除)
  sync_name   TEXT                         sync_name   TEXT      ← 新键
  sync_type   TEXT NOT NULL ← Qunee 类名    (sync_type 列删除)
  node_type / name / x / y / insert_order  node_type / name / x / y / insert_order

topology_links                          topology_links
  src_imac / dst_imac  INTEGER ← 指 imac    src_sync_name / dst_sync_name TEXT ← 指 sync_name
  link_seq / name / styles_json            link_seq / name / styles_json（不变）
```

### 迁移流程（v6，每会话、单事务）

```
读 topology_nodes 该会话所有行
  → 建 imac→sync_name 映射（sync_name 已存在）
  → 探测 sync_name 重复：若有，按 insert_order 去重重排（保唯一）
建新表 topology_nodes_new (PK session_id, sync_name；无 imac/sync_type)
  → INSERT…SELECT（丢 imac、丢 sync_type）
建新表 topology_links_new (src_sync_name/dst_sync_name)
  → INSERT…SELECT，端点经映射 imac→sync_name 改写
DROP 旧表 → RENAME 新表 → 重建索引
```

### 现导（Qunee/规划器）路径 —— 本次不改、仅验证

```
MCP build_artifacts(topology=<请求体内存拓扑>)
  → build_topology_artifacts(&Value)            ← 不读 DB
    → build_legacy_topology_json   imac=100+排序下标(现算)，_classPath=legacy_class_path(node_type)(现算)
    → build_legacy_topo_feature    src_node/dst_node = numeric_id(=sync_name)
    → build_legacy_mac_forwarding_table
```

---

## Implementation Units

### U1. 数据库 schema 与 v6 迁移：节点键改 sync_name、删 sync_type、连线端点改名
**Goal**：落地新表结构与现有库的平滑升级，作为后续所有单元的地基。
**Requirements**：R1, R2, R3, R5, R8（旧导出不兼容由 KTD6 接受）。
**Dependencies**：无（最先做）。
**Files**：
- `src-tauri/src/db.rs`（`P0_DOMAIN_SCHEMA_SQL` 改 topology_nodes/links 定义、索引；`migrations()` 追加 v6 + 新 `pub const ...SQL`；`safety_net_schema_sql()` 与新 schema 对齐；`SESSION_SCOPED_TABLES` 改列清单）
- `src-tauri/src/db.rs` 内或同模块的迁移 SQL 常量（参照 `RENAME_NETWORKCARD_NODE_TYPE_SQL` db.rs:362 范式；表重建参照 `ensure_topology_nodes_name_column` db.rs:260 的命令式守卫风格）
- 测试：`src-tauri/src/session_store.rs`（`migrations_expose_v1_through_v5_in_order` → 扩到 v6）；`src-tauri/src/db.rs` 内迁移单测（新增）
**Approach**：新 PK `(session_id, sync_name)`；`topology_links` 端点列 `src_sync_name`/`dst_sync_name`（TEXT），索引改 `(session_id, src_sync_name, dst_sync_name)`。v6 迁移按 HTD 流程表重建、单事务、每会话重映射。`safety_net_schema_sql()`（测试/新库路径）必须与迁移后结构字节一致，否则内存测试库与迁移后生产库分叉。
**Test scenarios**：
- 既有库（多会话、含连线与位置）迁移后：节点按 sync_name 可查、连线端点正确重映射、`imac`/`sync_type` 列消失、位置 x/y 保留。Covers R5。
- 迁移幂等性：v6 在已迁移库上重跑（或全新库）不报错、结果一致。
- 重复 sync_name 边界：构造含重复 sync_name 的旧行，迁移后仍满足新 PK 唯一（去重重排生效）。Covers KTD3。
- 全新库经 `safety_net_schema_sql()` 建出的结构 == 迁移后结构（列、PK、索引一致）。
- `migrations()` 含 v6 且顺序/描述正确。
**Verification**：cargo test 全绿；用一份含旧 imac 键的样例库迁移后人工核对节点/连线/位置无损。

### U2. topology_ops.rs：apply_op 全分支改 sync_name 键、移除 sync_type
**Goal**：增量增删改查（agent 落图主路径）改用 sync_name 键、去掉 sync_type 字段。
**Requirements**：R1, R2, R3, R6（错误码）。
**Dependencies**：U1。
**Files**：`src-tauri/src/topology_ops.rs`（`NodeAddArgs`/`NodeUpdateArgs`/`LinkAddArgs` 字段；node_add/node_update/node_delete/link_add 各分支 SQL 与键；`json_or_string_eq` 对 sync_type 的对账移除；`IMAC_TAKEN`→`SYNC_NAME_TAKEN`）；同文件 `#[cfg(test)]` 测试更新。
**Approach**：node_add 以 `(session_id, sync_name)` 为冲突键，去掉 `imac`/`sync_type` 绑定与幂等对账中的 sync_type 比较；node_update/delete `WHERE ... AND sync_name = ?`；link_add 端点存在性检查与写入用 sync_name；node_delete 的"被连线引用"统计改 `src_sync_name/dst_sync_name`。重试需重发同 sync_name 的语义不变。
**Test scenarios**：
- node_add 重复 sync_name → `SYNC_NAME_TAKEN`；重试重发同 sync_name 幂等成功（不报错、不重复插入）。
- node_update 改坐标/名称按 sync_name 命中；不存在的 sync_name → NOT_FOUND。
- node_delete 被连线引用时拒删（按 sync_name 统计）；无引用时成功。
- link_add 引用不存在节点 → UnknownNode；自环（src==dst sync_name）期望计数正确。
- node_add 不再接受/写入 sync_type 字段（schema 层移除后该字段缺失不报错）。
**Verification**：cargo test 全绿；apply_operations 增删节点/连线端到端落库键为 sync_name。

### U3. topology_sidecar_routes.rs：initialize 写入、inspect/validate 路由改 sync_name
**Goal**：拓扑初始化落库与只读路由改用 sync_name、停止 mint imac/sync_type。
**Requirements**：R1, R2, R3。
**Dependencies**：U1。
**Files**：`src-tauri/src/topology_sidecar_routes.rs`（`persist_initialized_topology` 不再算 `imac=100+index`、不再写 `sync_type`，以 sync_name 为键并解析连线端点为 sync_name；`inspect` 路由 SELECT/映射改 sync_name 与新列；`validate` 无参分支的悬空连线检查改 `src_sync_name/dst_sync_name` 关联 `sync_name`）；同文件测试。
**Approach**：`persist` 以 `node.numeric_id`(=sync_name) 直接作键；连线端点 `imac_by_node_id` 映射替换为 `sync_name_by_node_id`。inspect 返回行的键字段从 imac 改 sync_name。
**Test scenarios**：
- initialize 一个 3 节点拓扑后，inspect 返回节点以 sync_name 标识、连线端点为 sync_name、无 imac/sync_type 字段。
- validate 无参：构造端点指向不存在 sync_name 的连线 → 报悬空连线；正常拓扑 → 通过。
- initialize 不写 sync_type（落库行无该列/值）。
**Verification**：cargo test 全绿；真机 initialize → 画布正常渲染。

### U4. topology_query_command.rs：query_topology 与 update_node_position 改 sync_name
**Goal**：前端读取拓扑与节点拖动落位的命令改用 sync_name 键。
**Requirements**：R1, R2, R3, R7。
**Dependencies**：U1。
**Files**：`src-tauri/src/topology_query_command.rs`（`TopologyNodeRow`/`TopologyLinkRow` 字段去 imac/sync_type、加/用 sync_name；SELECT 列；行映射）；`update_node_position` 命令（当前按 imac 定位 → 按 sync_name）；同文件测试。
**Approach**：返回结构以 sync_name 为节点键、连线端点为 sync_name。`update_node_position` 入参键改 sync_name（与前端 U6 对齐）。
**Test scenarios**：
- query_topology 返回 camelCase `syncName`/`srcSyncName`/`dstSyncName`，无 `imac`/`syncType`。
- update_node_position 按 sync_name 命中并更新 x/y；不存在的 sync_name 不崩、按现有错误风格处理。
**Verification**：cargo test 全绿。

### U5. MCP 工具 schema 与 SKILL.md：键改 sync_name、删除 syncType 指引
**Goal**：让 agent 按新字段构造操作，避免按旧 imac/syncType 乱填。
**Requirements**：R6。
**Dependencies**：U2, U3, U4（后端字段定稿后再改 schema 描述）。
**Files**：
- `src-node/mcp/topology-tools.ts`（`inspect` 描述的返回字段、`apply_operations` 描述里"locate imac"与"重发同 imac"、`node_add`/`node_update`/`node_delete`/`link_add` 的 zod schema：移除 `syncType`、键字段 `imac`→`syncName`、端点 `srcImac/dstImac`→`srcSyncName/dstSyncName`）；同目录 `topology-tools.test.ts`
- `.claude/skills/tsn-topology/SKILL.md`（领域语义表、编辑路径 step1-3 的 inspect 字段与"复制 syncType 原文"、footer 的 `IMAC_TAKEN`）
**Approach**：把"键"的措辞从 imac 统一到 sync_name（逻辑序号）；删除 syncType 相关的"照抄原文"指引（该字段不复存在）；错误码措辞同步 `SYNC_NAME_TAKEN`。
**Test scenarios**：
- node_add schema 不含 syncType、含 syncName；缺 syncType 不报校验错。
- link_add schema 用 srcSyncName/dstSyncName。
- inspect/apply 描述不再提 imac/syncType（文案核对）。
- Test expectation：SKILL.md 为纯指引文档，无行为测试；改动靠现有 verify-skills 对账与人工核对。
**Verification**：worker 构建（`npm run build:worker`）后真机：agent 增/减节点经 MCP 正确落库为 sync_name 键。

### U6. 前端：身份与画布 id 改 sync_name、用户可见处不再显示 imac
**Goal**：前端彻底去 imac，节点身份/画布 id/选中/位置提交/详情显示统一到 sync_name。
**Requirements**：R7。
**Dependencies**：U4（query 返回结构定稿）。
**Files**：
- `src/sessions/topology-snapshot.ts`（`TopologyNodeRow`/`TopologyLinkRow` 去 imac/syncType、键字段 syncName、端点 srcSyncName/dstSyncName）
- `src/app/components/workspace-pane/topology-flow.ts`（节点 `id`/`data`、`centers` 键、`takeOrd`、边 `source`/`target` 全部从 imac 改 sync_name）
- `src/app/components/workspace-pane/index.tsx`（`CommitNodePositionArgs` 键、选中 id 比较、overlay 键、连线端点查节点、用户可见 "IMAC" 详情行与节点体 `imac N` 改为展示逻辑序号 sync_name）
- `src/app/App.tsx`（stale-selection 守卫 `String(node.imac)` → sync_name）
- 测试：`src/app/components/workspace-pane/workspace-pane.test.tsx`、`src/app/App.test.tsx`、`src/app/hooks/use-topology-snapshot.test.ts`（fixtures 与断言从 imac 改 sync_name）
**Approach**：React Flow 节点 id 用 `node.syncName`（本就是字符串，比 imac 更贴合 `String(id)` 契约）；选中 id、位置提交键、overlay 键随之改。用户可见的"IMAC"标签改为"节点号"展示 sync_name（与对话/规划器一致）。
**Test scenarios**：
- 画布把 DB 行映射为 React Flow：节点 id == syncName、边 source/target == 端点 syncName。
- 选中节点/连线：选中 id 用 syncName 关联正确。
- 拖动节点提交 update_node_position 带 syncName。
- 节点详情/节点体展示逻辑序号、不出现 imac 字样。
- 标签防撞计数器（takeOrd）改 syncName 后仍正确去重。
**Verification**：vitest 全绿；真机画布渲染、选中、拖动、详情显示均正常且无 imac。

### U7. 导入导出与遗留对账收尾
**Goal**：导入导出随新列清单一致，移除 sync_type 相关校验残留；明确旧导出文件不兼容。
**Requirements**：R3, R8, KTD6。
**Dependencies**：U1（`SESSION_SCOPED_TABLES` 在 U1 改）。
**Files**：`src-tauri/src/session_import.rs`（`validate_text_field` 的 `sync_type` 分支移除、相关测试列清单）、`src-tauri/src/session_export.rs`（按新 `SESSION_SCOPED_TABLES` 自动生效，核对测试）；两文件 `#[cfg(test)]`。
**Approach**：导入导出本就按 `SESSION_SCOPED_TABLES` 动态拷列，U1 改列后自动跟随；本单元清理 sync_type 专项校验与硬编码列清单测试，并确认导出→导入往返（新格式）无损。
**Test scenarios**：
- 新格式会话导出→导入往返：节点（sync_name 键）、连线（sync_name 端点）、位置无损。
- validate_text_field 不再特判 sync_type（移除后导入正常）。
- Covers R8：旧格式导出文件导入路径——记录为已知不兼容（不强制测试旧文件，按 KTD6 接受）。
**Verification**：cargo test 全绿；真机导出再导入一致。

---

## Scope Boundaries

**本计划做**：节点键 imac→sync_name、删 sync_type 列、连线端点改名、全链路（写入/查询/前端/MCP/SKILL/导入导出）收口、现有库 v6 自动迁移。

### Deferred to Follow-Up Work
- **拓扑阶段 INET 验证**：另一份点子梳理（`docs/ideation/2026-06-17-topology-stage-inet-verification-ideation.html`）的内容，本计划不含。本重构让库更贴近规划器模型，是其前置利好但不在本范围。
- **规划器/真机导出落地**：`build_artifacts` 现导路径本次仅验证不改动；真正对接规划器/真机是后续周期。

### 明确不做（非目标）
- 不保留 imac/sync_type 双轨兼容（R8）。
- **旧"已导出会话文件"不再可导入**（KTD6，已与 boss 确认接受）。boss 本机当前活动库走自动迁移、不受影响。
- 不改规划器真正需要的字段：端口号（styles_json 的 leftLabel/rightLabel）、速率、node_type、name 均保留。

---

## Risks & Dependencies

- **R-改主键迁移**（高关注）：表重建 + 连线端点重映射须单事务、每会话一致；`safety_net_schema_sql()` 须与迁移后结构字节一致。缓解：U1 专门的迁移单测覆盖多会话/含连线/含位置/幂等/重复 sync_name 边界；用 boss 本机一份真实库做迁移后人工核对。
- **R-重复 sync_name**：旧 schema 未约束 sync_name 唯一，历史 node_add 理论上可能造重复，迁移须去重重排，否则违反新 PK。缓解：迁移内探测+修复 + 专门测试用例。
- **R-imac 是用户可见字段**：re-key 同时改 UI 展示，须确认画布 id/选中/拖动/详情四处身份契约全切字符串 sync_name 不脱节。缓解：U6 集中改 + vitest + 真机四项验证。
- **R-worker 跑 dist 产物**：MCP 工具改动须 `npm run build:worker` 后才在真机生效（项目既有坑）。缓解：U5 验证步骤显式包含 build:worker。
- **依赖顺序**：U1 是地基；U2/U3/U4 依赖 U1；U5 依赖 U2-U4 字段定稿；U6 依赖 U4；U7 依赖 U1。

---

## Sources & Research

- 旧真实配置（规划器格式事实源）：`/Users/jiabozhang/Library/Application Support/xz_em/files/*/`（`topology.json` 用 imac+_classPath = Qunee；`topo_feature.json` 用 src_node/dst_node=逻辑序号；`node.json` 以 "0"/"1"/"2"/"global" 为键；`static_mac_cfg.json` 以逻辑序号标识、mac→outport）。
- 代码现状（本会话调研，file:line）：节点身份分配 `topology_sidecar_routes.rs:259-289`（imac=100+index、sync_name=numeric_id）、`topology_ops.rs:24-31,120-133`（node_add 任意 imac/sync_name，sync_name 无唯一约束）；imac 为键的全部位置 `db.rs:69-96`（PK、索引、无 links↔nodes FK）、`topology_ops.rs`（apply_op 各分支）、`topology_sidecar_routes.rs`（persist/inspect/validate）、`topology_query_command.rs`；sync_type 用法 `db.rs:78`（NOT NULL）、`topology_ops.rs:122-183`、`topology_query_command.rs:39-92`、生产者 `legacy_class_path`（`topology_backfill.rs:191`/`topology_compute.rs:2220`）；现导不读库 `topology_compute.rs:2110-2475` + `topology_sidecar_routes.rs:141-155`；迁移机制 `db.rs:366-399`(v5)、`db.rs:362`(常量范式)、`db.rs:260`(列迁移范式)、`db.rs:251`(safety_net)、`db.rs:282-332`(SESSION_SCOPED_TABLES)。
- 前端/MCP/导入导出消费面（本会话调研）：`src/sessions/topology-snapshot.ts:16-31`、`src/app/components/workspace-pane/topology-flow.ts:92-130,151`、`src/app/components/workspace-pane/index.tsx:62,355-360,391-407,512,589`、`src/app/App.tsx:96`；`src-node/mcp/topology-tools.ts:67,134,293-319`（含"复制 syncType 原文"）、`.claude/skills/tsn-topology/SKILL.md:32-65`；`src-tauri/src/session_export.rs:214-239`、`src-tauri/src/session_import.rs:29,298-333,370`。
- 同源点子梳理：`docs/ideation/2026-06-17-topology-stage-inet-verification-ideation.html`。
