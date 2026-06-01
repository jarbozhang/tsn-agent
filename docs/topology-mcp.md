# TSN Topology MCP 契约

`tsn_topology` 是 P0 确定性拓扑服务。它只处理拓扑领域的固定规则，不做自然语言理解、不生成完整 project、不推进 workflow，也不导出 HTML。

## 工具列表

| MCP tool | 用途 |
|---|---|
| `topology.describe_templates` | 返回 P0 模板目录和参数约束。 |
| `topology.initialize` | 用结构化 `templateId` 和参数生成 `IntermediateTopology`。 |
| `topology.inspect` | 按稳定 selector 查询节点、链路、邻接和端口占用摘要。 |
| `topology.describe_artifacts` | 返回 legacy JSON artifact 的数量、大小和计数摘要。 |
| `topology.validate_intermediate` | 校验 `IntermediateTopology` 并返回结构化错误。 |
| `topology.build_artifacts` | 从 `IntermediateTopology` 构建四份 JSON artifact。 |
| `topology.validate_artifacts` | 校验 legacy JSON artifact 引用和基本 schema。 |
| `topology.apply_operations` | P0 支持 `link.delete`、`node.add`、`link.add` 的原子 operations。 |

Agent allowedTools 使用 SDK fully-qualified 名称，例如 `mcp__tsn_topology__topology_initialize`。

## 数据边界

Agent-facing MCP response 只使用 summary。`responseMode: "full"` 会返回 `FORBIDDEN_RESPONSE_MODE`，避免完整拓扑、完整 artifact、端口表、MAC 表或完整 changeSet 进入模型上下文。

本地 stage runner、fake agent 和 project bridge 可直接调用 `src/topology` domain 获取 full 数据，再合成 `CanonicalTsnProjectV0`。完整数据只进入本地 project/session storage 和导出层，不进入诊断日志。

## 初始化与编辑

从 0 初始化：

1. Project/Agent 层从自然语言和 `ScenarioConfig` 得到结构化参数。
2. 调用 `topology.describe_templates` 确认模板目录。
3. 调用 `topology.initialize` 生成 topology summary。
4. 本地 bridge 把 full `IntermediateTopology` 合成 canonical project。

已有拓扑编辑：

1. Project/Agent 层把用户引用解析为稳定 node/link ID。
2. 调用 `topology.inspect` 查询邻接和端口占用 summary。
3. 构造 P0 operations，例如插入交换机时 `[link.delete, node.add, link.add, link.add]`。
4. 先 dryRun，用户确认后用同一 snapshot 和 operations 重放 apply。

`node.delete`、`node.update`、`link.update` 属于 P1 完整 CRUD；P0 返回 `UNSUPPORTED_OPERATION`。

## Artifact

P0 构建四份 JSON：

- `topology.json`
- `topo_feature.json`
- `data-server.json`
- `mac-forwarding-table.json`

不生成 `mac-forwarding-table.html`，也没有 `topology.render_mac_table_html`。

## 错误 Envelope

错误固定包含：

- `code`
- `message`
- `path`
- `severity`
- `details`
- `retryable`
- `requiresUserClarification`

常见错误包括 `UNSUPPORTED_SCHEMA_VERSION`、`INVALID_TEMPLATE_PARAM`、`AMBIGUOUS_SELECTOR`、`UNKNOWN_ENDPOINT_NODE`、`PORT_ALREADY_USED`、`LIMIT_EXCEEDED`、`UNSUPPORTED_OPERATION` 和 `FORBIDDEN_RESPONSE_MODE`。

## 打包边界

P0 提供 Node stdio dev host：`src-node/dist/tsn-topology-server.mjs`。`build:worker` 会打包该 host，Tauri resources 会随包携带。

生产 sidecar 安全治理仍是后续 decision gate：固定随包路径、禁止从 `PATH` 解析、签名/hash 校验、private IPC 或 localhost-only、每会话 capability token 和 fail-closed 都需要单独验收。
