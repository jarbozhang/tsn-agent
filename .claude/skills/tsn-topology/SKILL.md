---
name: tsn-topology
description: 用自然语言生成、校验并导入 TSN 拓扑结果。在 TSN Agent 桌面应用中必须通过项目 stage runner 回传 topology 阶段结构化结果；独立使用时可一次产出 topology.json、topo_feature.json、data-server.json、mac-forwarding-table.json 与 mac-forwarding-table.html。
---

# TSN 拓扑生成 Skill

当用户描述或修改 TSN 拓扑时使用本 skill，例如“4 个交换机，每个交换机连接 5 个端系统”“画一个星型拓扑”“生成 topology”“生成 data-server”“MAC 转发表”“端系统+交换机组网”等。

本 skill 有两种运行模式：

- **TSN Agent 集成模式**：运行在当前 Tauri/React 桌面应用内。必须先生成 legacy 拓扑产物，再调用项目 stage runner，把结果写入 `TSN_AGENT_STAGE_RESULT_PATH`。这是当前 App 对话流程的最高优先级模式。
- **独立 skill 模式**：脱离 TSN Agent App 单独使用时，把五份文件写入工程师指定的 `target_dir`。

如果环境中存在 `TSN_AGENT_STAGE_RESULT_PATH`、`TSN_AGENT_SKILL_OUTPUT_DIR` 或 `TSN_AGENT_STAGE_RUNNER_PATH`，必须按 **TSN Agent 集成模式** 执行。

详细拓扑规则参见 `@docs/rules.md`。

---

## TSN Agent 集成契约

- 稳定阶段 ID：`topology`
- Skill 名称：`tsn-topology`
- 结构化结果 schema：`tsn-agent.stage-skill-result.v0`
- 唯一会改变 App 工程状态的输出：由项目 stage runner 写入 `TSN_AGENT_STAGE_RESULT_PATH` 的 JSON
- legacy 拓扑产物目录：`TSN_AGENT_SKILL_OUTPUT_DIR`
- 不要写入仓库文件；除临时文件外，只允许写入 `TSN_AGENT_SKILL_OUTPUT_DIR` 和 `TSN_AGENT_STAGE_RESULT_PATH`
- 不要手写最终 stage result JSON；必须由 `TSN_AGENT_STAGE_RUNNER_PATH` 指向的 runner 生成和校验

### 集成模式输入

当前 App 的宿主 prompt 会提供：

- `userIntent`：用户本轮原始需求
- `scenarioConfigId`：当前场景配置 ID，如有
- `fallbackIntent`：用户修改已有拓扑时，从当前工程推断出的旧拓扑规模，如有
- `TSN_AGENT_SKILL_OUTPUT_DIR`：skill 产物目录
- `TSN_AGENT_STAGE_RESULT_PATH`：stage result 写入路径
- `TSN_AGENT_STAGE_RUNNER_PATH`：项目 stage runner 路径
- 建议传给 stage runner 的结构化输入，如有

### 集成模式执行步骤

1. 读取 `@docs/rules.md`，把用户需求解析为中间表示 JSON。
2. 如果宿主 prompt 提供了 stage runner 结构化输入，优先沿用其中的 `userIntent`、`scenarioConfigId`、`fallbackIntent`，只根据用户本轮需求补充缺失字段。
3. 使用 `TSN_AGENT_SKILL_OUTPUT_DIR` 作为 `target_dir`，语义等同 `overwrite=true`。
4. 把中间表示写入临时 JSON 文件。
5. 调用当前项目的集成脚本生成 legacy 产物：

```bash
SKILL_DIR=".claude/skills/tsn-topology"
TMPIM="$(mktemp -t tsn-im-XXXXXX.json)"
# 将中间表示 JSON 写入 "$TMPIM"
TSN_AGENT_SKILL_OUTPUT_DIR="$TSN_AGENT_SKILL_OUTPUT_DIR" node "$SKILL_DIR/tools/run-topology-skill.js" "$TMPIM"
```

`tools/run-topology-skill.js` 会调用 builder、validator 和 HTML renderer，并在 `TSN_AGENT_SKILL_OUTPUT_DIR` 下生成：

- `topology.json`
- `topo_feature.json`
- `data-server.json`
- `mac-forwarding-table.json`
- `mac-forwarding-table.html`

6. 只有上一步成功后，调用项目 stage runner，把 legacy 产物导入为 App 的 canonical TSN project：

```bash
node "$TSN_AGENT_STAGE_RUNNER_PATH" \
  --stage topology \
  --input '<json>' \
  --skill-output-dir "$TSN_AGENT_SKILL_OUTPUT_DIR" \
  --result-path "$TSN_AGENT_STAGE_RESULT_PATH"
```

`--input` JSON 至少包含：

```json
{
  "userIntent": "<用户本轮原始需求>",
  "stage": "topology",
  "scenarioConfigId": "<当前场景配置 ID，可选>",
  "fallbackIntent": "<已有拓扑推断结果，可选>"
}
```

7. stage runner 成功后，用中文向用户解释拓扑摘要，并让用户确认或描述需要修改的地方。

### 集成模式回复边界

- 只说明拓扑阶段已经完成或正在等待确认的内容。
- 不要声称时间同步、流量规划、规划器输入、导出文件或仿真已经完成。
- 不要输出最终 stage result JSON。
- 如果缺少关键参数，优先给出合理默认值并说明后续可调整；只有会导致拓扑结构无法确定或端口冲突时才追问。
- 用户说“网卡”“端系统”“端”时，在 TSN Agent 产品语义中都映射为 `networkcard`。不要把“网卡8/网卡9”理解成交换机端口或网卡接口，它们是新增端系统节点。
- 双归属 `networkcard` 连接两台交换机时，两条物理链路必须使用不同的 `src_port`，通常第一条用 `0`、第二条用 `1`。不能让同一个 `(networkcard, port)` 承载两条物理链路。

---

## 独立 Skill 输入契约

脱离 TSN Agent App 单独使用时，工程师调用此 skill 应提供：

| 字段 | 必填 | 说明 |
|---|---|---|
| `intent` | 是 | 拓扑的自然语言描述 |
| `target_dir` | 是 | 目标 project 目录的相对或绝对路径 |
| `topology_hint` | 否 | 工程师手写的拓扑片段，格式为中间表示；skill 必须遵守，仅补全缺失字段 |
| `node_id_base` | 否 | `sync_name` 数值起始，缺省为 `0`；建议直接在中间表示中显式给 `node_id` |
| `imac_base` | 否 | `imac` 起始值，缺省为 `100` |
| `overwrite` | 否 | 缺省为 `false`：目标已有任一产物则失败；`true`：五份文件分别备份后覆盖 |

未明示的字段使用上述默认值。

---

## 中间表示

从自然语言中抽取如下中间表示 JSON：

```json
{
  "nodes": [
    {
      "node_id": 0,
      "node_type": "switch",
      "display_name": "SW0",
      "x": 80,
      "y": 220
    }
  ],
  "links": [
    {
      "src": 1,
      "src_port": 0,
      "dst": 0,
      "dst_port": 0,
      "speed": 1000
    }
  ]
}
```

字段规则：

- `node_type` 只能是 `switch`、`networkcard` 或 `server`。
- 用户说的“网卡”“端系统”“终端”“端”默认表示 `networkcard`。
- `speed` 只能是 `10`、`100`、`1000`、`10000`。
- `x`/`y` 可选，必须成对出现且为数字；提供时 builder 原样采用，省略时 builder 使用 TSN Agent 通用拓扑布局。
- 默认通用布局：交换机按 `x=80+300*i, y=220` 横向排列；端系统按主连接交换机分组，交替放在 `y=70` 和 `y=390` 两排。
- 用户说“N 个交换机，每个交换机连接 M 个端系统/网卡/端”或“X 个端系统分配到 N 台交换机”时，除非用户明确说交换机相互独立、不互联或不连接，否则交换机必须默认线型互联：`SW1-SW2-SW3-...-SWN`。
- 上述通用分布式拓扑的默认链路数是 `N*M + (N-1)`。例如“4 个交换机，每个交换机连接 5 个端系统”应生成 `20` 条端系统接入链路和 `3` 条交换机互联链路，共 `23` 条链路，不能只生成 20 条孤岛接入链路。
- 不要为了表达星型、总线、环形或树形填写 `layout` 字段；拓扑形态由 `links` 表达。
- 节点编号从 `node_id_base` 起递增；不要使用历史包袱式编号规则。
- 同一节点的端口号在所有物理链路中不能重复。
- 星型拓扑中心交换机按链路顺序分配端口 `0,1,2,...`；端系统通常使用端口 `0`。
- 双归属端系统必须使用不同 `src_port` 连接不同交换机。
- `display_name` 可省略；省略时 builder 会按类型自动生成，如 `ES0`、`SW0`、`PC0`。

---

## 歧义处理

下列情况必须追问，不要静默推断：

1. 节点类型不明，例如只说“几台设备”但没说明交换机、端系统或服务器。
2. 链路速率不明，且无法从场景默认值、用户片段或当前工程上下文推断。
3. 用户指定的端口与端口唯一性冲突。
4. 连接关系不明，例如只说“几个连起来”，但没有说明端系统接入哪台交换机、交换机之间如何互联或其他明确链路关系。
5. `topology_hint` 与 `intent` 冲突，例如 hint 是 3 个节点但自然语言说 4 个。

可默认推断的内容：

- 节点 `display_name`
- `imac` 分配
- MAC / IP 派生
- 节点坐标和 React Flow/Qunee 展示布局
- TSN Agent 当前场景配置提供的默认速率、同步假设或命名方式

在 TSN Agent 集成模式中，如果缺失项不会改变拓扑结构，可以先使用合理默认值生成拓扑，并在回复里说明“这些默认值后续可以调整”。

---

## 独立 Skill 执行步骤

### Step 1：前置检查

读取 `target_dir`：

- 目录不存在：立即失败，提示工程师创建目录或指定有效路径。
- 检查 `target_dir/topology.json`、`target_dir/topo_feature.json`、`target_dir/data-server.json`、`target_dir/mac-forwarding-table.json`、`target_dir/mac-forwarding-table.html` 五份文件是否已存在。
- 若任一存在且 `overwrite=false`：失败，报告已有同名文件，请确认 `overwrite=true` 或换路径。
- 若 `overwrite=true`：后续写盘前逐份备份。

### Step 2：调用 builder

把中间表示写到临时文件，通过 stdin 传给 builder：

```bash
TMPIM="$(mktemp -t tsn-im-XXXXXX.json)"
# 将中间表示 JSON 写入 "$TMPIM"
node tools/topology-builder.js < "$TMPIM"
```

成功时 stdout 格式：

```json
{
  "topology_text": "<canonical topology.json 字符串>",
  "topo_feature_text": "<canonical topo_feature.json 字符串>",
  "data_server_text": "<canonical data-server.json 字符串>",
  "mac_forwarding_table_text": "<canonical mac-forwarding-table.json 字符串>",
  "display_names": ["ES0", "SW0"]
}
```

失败时 stderr 格式：

```json
{
  "ok": false,
  "stage": "build",
  "error": {
    "type": "<ErrorName>",
    "message": "<错误信息>"
  }
}
```

退出码：

- `0`：成功
- `1`：业务错误，修正中间表示后重试
- `2`：CLI 用法错误，不进入修复循环

### Step 3：调用 validator

把 builder 输出的四份 JSON 写入 staging 目录，不要先写入 `target_dir`，然后运行：

```bash
node tools/validate-topology.js <staging>/topology.json <staging>/topo_feature.json
node tools/validate-mac-forwarding-table.js <staging>/topology.json <staging>/mac-forwarding-table.json
```

stdout 格式：

```json
{
  "ok": true,
  "errors": []
}
```

退出码：

- `0`：校验通过
- `1`：schema、reference 或 consistency 错误，修正中间表示后重试
- `2`：IO 或 CLI 用法错误，立即报告

修复循环边界：`max_repair_attempts = 3` 是 builder 和 validator 合计的修复次数。超过 3 次仍失败时，不写盘，输出诊断报告。

### Step 4：渲染 MAC 转发表 HTML

只有 `mac-forwarding-table.json` 通过校验后，才允许渲染 HTML：

```bash
node tools/render-mac-forwarding-html.js <staging>/mac-forwarding-table.json
```

把 stdout 写入 `<staging>/mac-forwarding-table.html`。禁止在 JSON 未校验前生成或写入 HTML。

### Step 5：安全写盘

只有 builder、validator 和 HTML renderer 全部成功后，才允许碰 `target_dir`。

事务流程：

1. 在 `target_dir` 同文件系统创建 staging 目录，保证 `renameSync` 原子。
2. 确认 staging 内已有五份产物。
3. 若 `overwrite=true` 且目标文件存在，对五份文件逐一备份，命名为 `<file>.bak.<ISO timestamp 含 ms>-<6 位随机>`。
4. 依次使用 Node `fs.renameSync` 把五份文件从 staging 移入 `target_dir`。
5. 任一 rename 失败时，把已移动的目标文件移回 staging，删除 staging，报告失败。
6. 成功后清理 staging。

不要用 shell `mv` 拼接路径，避免路径注入和半成品状态。

---

## 输出产物说明

独立模式和集成模式都会先得到 legacy 拓扑产物：

- `topology.json`：拓扑结构 canonical JSON。
- `topo_feature.json`：节点特征和端口相关信息。
- `data-server.json`：旧 Qunee 展示数据源；在当前 App 中只作为兼容产物，不作为 React Flow 的最终数据契约。
- `mac-forwarding-table.json`：标准 MAC 转发表 canonical JSON。
- `mac-forwarding-table.html`：由已校验 JSON 渲染的人读 HTML。

在 TSN Agent 集成模式中，App 最终使用 stage runner 导入这些 legacy 产物，并转换为当前项目的 canonical TSN project。React Flow 展示数据、NED、规划器输入和 INET 文件由后续 App 导出流程生成，不由本 skill 直接承诺。

MAC 转发表说明：

- 每条记录是一个可达目的 MAC 到出端口的映射。
- 记录数可能大于交换机已连接端口数。
- 多个目的 MAC 可以共用同一个出端口号。

---

## 失败输出

任何阶段失败时都输出中文诊断，不写半成品文件：

```text
拓扑生成失败

阶段: <前置检查 | 意图解析 | builder | validator | 写盘 | stage runner>
原因:
  - <错误1>
  - <错误2>

当前中间表示:
  <JSON>

建议:
  - <下一步建议>
```

在 TSN Agent 集成模式中，如果 legacy 产物已生成但 stage runner 失败，必须明确说明“App 工程状态未更新”，并把 stage runner 错误作为失败原因。

---

## 工具索引

- `tools/run-topology-skill.js`：TSN Agent 集成脚本。读取中间表示，写入 `TSN_AGENT_SKILL_OUTPUT_DIR`，并生成五份 legacy 产物。
- `tools/topology-builder.js`：确定性骨架生成器，一次产出 topology、topo_feature、data-server、mac-forwarding-table 四份 canonical JSON 文本。
- `tools/validate-topology.js`：校验 topology 与 topo_feature 的 schema、reference 和 consistency。
- `tools/validate-mac-forwarding-table.js`：校验 topology 与 mac-forwarding-table 的一致性。
- `tools/render-mac-forwarding-html.js`：HTML 渲染器，只在 MAC 转发表 JSON 校验通过后调用。
- `docs/rules.md`：业务规则参考。

---

## 反例与边界

- 用户说“几台机器随便连一下”：必须追问拓扑形态与节点类型。
- 用户说“100Gbps 链路”：`speed=100000` 不在枚举内，必须追问 `10/100/1000/10000` 选一。
- 用户只给了节点没给链路：可以生成空链路拓扑，但必须提醒用户可能漏说连接关系。
- 用户说“4 个端系统 1 个交换机的星型”：可以直接生成，端口默认 `ES.0 / SW.0,1,2,3`。
- 用户说“网卡8 同时接交换机3和交换机4”：必须建模为 `networkcard` 节点双归属，两条链路使用不同 `src_port`。
