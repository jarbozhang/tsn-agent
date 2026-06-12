<!-- 消费方式：按场景注入（scenarioConfigId = generic-tsn 时随主索引注入；也是未知场景的回退指引）。 -->

# 通用 TSN 场景指引

面向通用 TSN 组网规划：交换机线型/环形互联，端系统均匀挂载。无行业规范图约束，按用户描述的规模与形态直接参数化。

## 推荐参数默认

用户未指定时显式传给 `topology_initialize`（`initialize` 不兜底）：

- `switchCount`：缺省 `4`
- `endSystemsPerSwitch`：缺省 `2`
- `dataRateMbps`：缺省 `1000`

合法域以 `describe_templates` 为准，本文件只给推荐值。

## 模板选择

- **默认 `generic-line`**：用户描述"N 台交换机线型/串联，每台接 M 个端系统"，或未指定拓扑形态时。参数 `switchCount=N`、`endSystemsPerSwitch=M`、`dataRateMbps=用户速率（缺省 1000）`。
  - 示例："4 个交换机每个接 5 个端系统" → `generic-line`，`switchCount=4`，`endSystemsPerSwitch=5`。
  - 只有用户明确要求"交换机相互独立""交换机之间不互联""每台交换机单独成星型"时，才省略交换机互联（由模板参数表达）。
- **`generic-ring`**：用户明确要环形、交换机环网、或环形冗余时。参数同 `generic-line`。

## 基础示例 preset

| 规范图/别名 | `templateId` | 参数 JSON | 布局说明 |
|---|---|---|---|
| 基础线型 | `generic-line` | `{"switchCount":4,"endSystemsPerSwitch":2,"dataRateMbps":1000}` | 单行线型，端系统上下交错 |
| 基础环网 | `generic-ring` | `{"switchCount":4,"endSystemsPerSwitch":2,"dataRateMbps":1000}` | 线型布局 + 首尾闭环链路 |
