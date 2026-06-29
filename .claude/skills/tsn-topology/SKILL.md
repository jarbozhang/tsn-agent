---
name: tsn-topology
description: HIBridge Agent 拓扑阶段主索引。承载场景无关的领域语义、操作流程与场景路由；各场景的模板选择与推荐参数在 references/<场景id>.md。
---

<!-- 消费方式：每次运行注入（主索引，场景无关）。场景细节见 references/，由系统按当前场景自动注入对应文件。 -->

# TSN 拓扑 Skill 主索引

这是拓扑阶段**可编辑指引**的主索引，只放开工前必须知道的场景无关内容：领域语义、操作流程、场景路由。各场景的模板怎么选、参数推荐多少，在 `references/<场景id>.md` 里按场景分开放。

## 参数从哪来

- **推荐默认值看场景 reference**（见下方「场景路由」）。读出来后要**显式传给 `topology_initialize`**——它不替你补默认，缺参数会返回 `requires_clarification`。
- **参数的合法范围（类型 / 上下限 / 枚举）以 `topology_describe_templates` 的返回为准**，本文件和 reference 都不复述合法域。
- 坐标布局、MAC/IP 派生、链路数、结构校验这些生成细节由 MCP 确定性算好，指引文件不定义生成规则。

## 场景路由

当前场景 id 在阶段结构化输入的 `scenarioConfigId` 字段。系统已按 id 把对应场景 reference 正文注入到下方场景分隔标记之后。

| `scenarioConfigId` | 场景 | reference |
|---|---|---|
| `generic-tsn` | 通用 TSN | `references/generic-tsn.md` |
| `aerospace-onboard` | 箭载 TSN | `references/aerospace-onboard.md` |
| 未知 / 缺失 | 按通用处理 | `references/generic-tsn.md` |

调 `topology_describe_templates` 时带上 `scenario` 参数，拿到的是该场景模板集。用户需求超出当前场景模板时去掉 `scenario` 重查全量。

## 领域语义

### 节点类型与显示名

| 概念 | 库值 `node_type` | 前缀 |
|---|---|---|
| 交换机 | `switch` | `SW` |
| 端系统 | `endSystem` | `ES` |
| 控制器 | `server` | — |

**显示名唯一规则**：画布显示名优先取节点的 `name`（如 `SW-1`）；没有 `name` 才回退 前缀+`syncName`。用户提到 `SW-N`/`ES-N` 时先拿 inspect 的 `name` 精确匹配，匹配不到再用前缀+`syncName` 匹配——不要按列表顺序折算。

### 链路速率

`speed` / `dataRateMbps` 是整数 Mbps。常见取值 `{10, 100, 1000, 10000}`，1000 最常用。确切合法域以 `topology_describe_templates` 为准。新加链路时用户没提速率就省略（后端缺省落 1000）。

## 从零初始化

1. 规模/形态/冗余缺失或模糊时先用中文编号选项问（把场景推荐默认列为推荐），别默默套默认。用户只给组网名也一样——preset 补全的参数是你替他做的假设，要先列出来确认。
2. 调 `topology_describe_templates`（带 `scenario`）拿模板目录和合法域。
3. 按场景 reference 的「模板选择」定 `templateId` 和参数，**显式**传给 `topology_initialize`。
4. 用 `topology_inspect` 看落库结果。
5. 中文简要说当前拓扑，等用户确认（不用再 `validate`）。

## 增量编辑

构造原子 operations（`node_add` / `node_update` / `node_delete` / `link_add` / `link_delete`）。`node_add` 可带 `name`（交换机 `SW-N`、端系统 `ES-N`、服务器 `SRV-N`，序号接现有最大值往下）。新 `mid`/`linkSeq` 避开 inspect 已占用的值。`node_update` 用于改名/改属性；`node_add` 的 syncName 重复报 `SYNC_NAME_TAKEN`。

**删关键项前先问**：`node_delete`/`link_delete` 一个看起来关键的节点或链路（唯一骨干、删了会断连通）前，先用中文跟用户确认，别擅自删。

## 撤销

用户说「撤销/回退」时调 `topology.undo`（无参数）。指代不清先用中文编号选项问清楚再调。撤销后先 inspect 重新确认当前拓扑。

## 结构校验

apply_operations 已自动带校验结论（`validation` 字段），通常不用再调 validate。看 `validation.ran` 和 `errors[]`（中文）把问题告诉用户。

## 回复边界

- 中文简要说当前拓扑结果，等用户确认或继续改。
- 不要声称时间同步/流量规划/导出文件已完成。
- 不要把完整端口表/MAC 表/artifact/changeSet 写进对话。
- 不要声称仿真已启动/已完成。
