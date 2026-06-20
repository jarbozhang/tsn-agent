<!-- 消费方式：按场景注入（scenarioConfigId = generic-tsn 时随主索引注入；也是未知场景的回退指引）。 -->

# 通用 TSN 场景指引

通用 TSN 组网：交换机线型或环形互联、端系统均匀挂载。没有行业规范图约束，按用户说的规模和形态直接参数化就行。

## 参数默认值

用户没指定时，下面这些要**显式**传给 `topology_initialize`（它不替你补默认）：

- `switchCount`（交换机数量）：缺省 `4`
- `endSystemsPerSwitch`（每台交换机挂几个端系统）：缺省 `2`
- `dataRateMbps`（链路速率）：缺省 `1000`

合法范围以 `describe_templates` 为准，这里只给推荐值。

## 选哪个模板

- **默认 `generic-line`**：用户说「N 台交换机线型/串联，每台接 M 个端系统」、或没说拓扑形态时。参数填 `switchCount=N`、`endSystemsPerSwitch=M`、`dataRateMbps=用户速率`（缺省 1000）。
  - 例：「4 个交换机每个接 5 个端系统」→ `generic-line`，`switchCount=4`、`endSystemsPerSwitch=5`。
  - 只有用户明确说「交换机相互独立」「交换机之间不互联」「每台单独成星型」时，才让交换机之间不互联（由模板参数表达）。
- **`generic-ring`**：用户明确要环形、交换机环网、或环形冗余时。参数填法同 `generic-line`。

## 基础示例 preset

| 规范图/别名 | `templateId` | 参数 JSON | 布局说明 |
|---|---|---|---|
| 基础线型 | `generic-line` | `{"switchCount":4,"endSystemsPerSwitch":2,"dataRateMbps":1000}` | 单行线型，端系统上下交错 |
| 基础环网 | `generic-ring` | `{"switchCount":4,"endSystemsPerSwitch":2,"dataRateMbps":1000}` | 线型布局 + 首尾闭环链路 |
