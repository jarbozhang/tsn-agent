---
name: tsn-topology
description: TSN Agent 拓扑阶段主索引。承载场景无关的领域语义、操作流程与场景路由；各场景的模板选择与推荐参数在 references/<场景id>.md。
---

<!-- 消费方式：每次运行注入（主索引，场景无关）。场景细节见 references/，由系统按当前场景自动注入对应文件。 -->

# TSN 拓扑 Skill 主索引

这是拓扑阶段**可编辑指引**的主索引，只放开工前必须知道的场景无关内容：领域语义、操作流程、场景路由。各场景的模板怎么选、参数推荐多少、规范图 preset，在 `references/<场景id>.md` 里按场景分开放。

## 参数从哪来

- **推荐默认值看场景 reference**（见下方「场景路由」）。读出来后要**显式传给 `topology_initialize`**——它不替你补默认，缺参数会返回 `requires_clarification`。
- **参数的合法范围（类型 / 上下限 / 枚举）以 `topology_describe_templates` 的返回为准**，本文件和 reference 都不复述合法域。
- 坐标布局、MAC/IP 派生、链路数、结构校验这些生成细节由 MCP 确定性算好，指引文件不定义生成规则。

## 场景路由

当前场景 id 在阶段结构化输入的 `scenarioConfigId` 字段。系统已按这个 id，把对应场景的 reference 正文自动注入到下方场景分隔标记之后；其它场景的文件可按注入末尾给出的「可用参考文件」绝对路径用 Read 查阅。

| `scenarioConfigId` | 场景 | reference 文件 |
|---|---|---|
| `generic-tsn` | 通用 TSN | `references/generic-tsn.md` |
| `aerospace-onboard` | 箭载/舰载 TSN | `references/aerospace-onboard.md` |
| 未知 / 缺失 | 按通用处理 | `references/generic-tsn.md` |

调 `topology_describe_templates` 时带上 `scenario` 参数（值 = 当前 `scenarioConfigId`），拿到的是该场景的模板候选集。用户需求超出当前场景的模板集时，先去掉 `scenario` 重查全量再回答。

## 领域语义

### 节点类型与显示名

| 领域概念 | 库值 `node_type` | 前缀 | 说明 |
|---|---|---|---|
| 交换机 | `switch` | `SW` | |
| 端系统 | `endSystem` | `ES` | 用户说的"端系统""端""网卡8/网卡9"都指端系统节点（"网卡"是口头叫法，**不是**交换机端口或物理网卡）。inspect 的 rows 和构造 op 时照抄这个库值原文 |
| 控制器 | `server` | — | 当前模板不生成 server；画布对非 switch 一律按端系统显示 |

- 首期**不做** `T10` 类型。
- **显示名怎么定**（显示名的唯一权威规则）：画布显示名**优先用节点的 `name`**（initialize 落库的逻辑名，如 `SW-1`/`ES-1`）；没有 `name` 才回退成 前缀+`syncName`。用户提到 `SW-N`/`ES-N` 时，先拿 rows 的 `name` 精确匹配，匹配不到再用 前缀+`syncName` 的派生名匹配——**不要**按列表顺序或"第 N 台"去折算。

### 链路速率

`dataRateMbps` 是整数 Mbps，常见取值 `{10, 100, 1000, 10000}`，1000 最常用。确切合法域以 `topology_describe_templates` 为准。

## 从零初始化（当前 project 还没有拓扑）

1. 从用户需求和当前场景 reference 的「推荐参数默认」提取结构化参数。
2. 调 `mcp__tsn_topology__topology_describe_templates`（带 `scenario`），拿模板目录和参数 schema（字段名和**合法域**以这个返回为准）。
3. 按场景 reference 的「模板选择」和「规范图 preset 表」定下 `templateId` 和参数，**显式**传给 `mcp__tsn_topology__topology_initialize`；它直接写工程数据库、返回 `mutationId`（右侧据此落图），并替换该会话已有的拓扑。
4. 用 `mcp__tsn_topology__topology_inspect` 看落库结果。
5. 用中文讲一下当前拓扑摘要，等用户确认。（`initialize` 已经校验并落库，不用再 `validate` 复检。）

## 已有拓扑的增量编辑（当前 project 已有拓扑）

用户要插交换机、改连接时：

1. 调 `mcp__tsn_topology__topology_inspect`（无参数）拿该会话全部 rows：nodes（syncName/name/nodeType/x/y/insertOrder）+ links（linkSeq/name/srcSyncName/dstSyncName/stylesJson）。节点身份是 `syncName`（逻辑序号），连线两端 `srcSyncName`/`dstSyncName` 引用节点的 syncName。
2. 在 rows 里按 name/nodeType/连接关系找到目标节点和链路，拿到准确的 syncName / linkSeq。用户的指代不唯一时，先用中文数字编号给选项问清楚。匹配按上面「显示名怎么定」来。
3. 构造原子 operations（比如插一台交换机 = `[link_delete, node_add, link_add, link_add]`）：新节点的 `nodeType` 照抄 inspect 里同类节点的原文，新链路的 `stylesJson` 参照已有链路、`srcSyncName`/`dstSyncName` 填两端节点的 syncName；新的 `syncName`/`linkSeq` 要避开 rows 里已经占用的值。
4. 调 `mcp__tsn_topology__topology_apply_operations`；不要把 rows 或 changeSet 写进对话。
5. 按下面「结构校验」验一遍库内结构，把结论告诉用户。

支持的 op：`node_add` / `node_update` / `node_delete` / `link_add` / `link_delete`（字段 camelCase，详见工具 schema）。"移动节点""改属性"用 `node_update`；`node_add` 撞上已占用的 syncName 会报 `SYNC_NAME_TAKEN`。

## 结构校验（apply_operations 改完拓扑后必做）

每次 `mcp__tsn_topology__topology_apply_operations` 改完拓扑，调 `mcp__tsn_topology__topology_validate`（**不传任何参数**）验库内已落库拓扑的结构：连通性、端口配对、孤立节点、转发可达、节点角色、编号重复。（`initialize` 已经校验过，不用复检。）

- `summary.errors[]`（中文）非空 → **把问题逐条如实告诉用户、让他改**，不要声称结构没问题。
- `errors[]` 为空 → 结构没问题（仅结构级），简短带过即可。
- 这是 `仅结构级` 校验：只说明结构连通可达，**不**代表时延/调度已验（那是后面阶段的事）。

## 回复边界

- 用中文简要说当前拓扑阶段的结果，等用户确认或继续改。
- 不要声称时间同步、流量规划、导出文件已经完成。
- 当前没有接入 OMNeT++/远程仿真 runner：遇到"启动仿真""SSH 执行""远程运行""稍后通知结果"这类请求，要说明本次不会真的执行、也不会后台通知，**不得**声称仿真已启动或已完成。
- 不要把完整端口表、完整 MAC 表、完整 artifact 或完整 changeSet 写进对话。
