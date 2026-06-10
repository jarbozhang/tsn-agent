---
date: 2026-06-10
topic: streaming-tool-call-cards
focus: 推理过程中实时展示工具调用卡片（像 Claude Code），并兼顾后续替换/接入其他 agent 客户端（qwen 等）
mode: repo-grounded
---

# Ideation: 流式工具调用卡片（客户端可插拔视角）

## Grounding Context（Codebase Context）

当前工具卡片是「一次推理完整结束后一次性渲染」。端到端链路与瓶颈：

- **worker** `src-node/claude-agent-worker.mjs`：`collectToolCalls`（L237-254）已在 `for-await` 循环内**实时累积** `toolCallsById`（use 阶段补 args，result 阶段补 status/result）；但只通过 `done` 事件末尾**一次性**回传（L322-328），中途只 emit `chunk`/`session`（L1448-1454）。
- **Rust** `src-tauri/src/commands.rs`：`handle_worker_line`（L436-489）**已逐行即时处理并 emit** `chunk`/`session`（`emit_claude_event` L551-567）；`done` 才第一次看到 `tool_calls`。基础设施已具备逐行流式能力。
- **前端** `src/agent/agent-adapter.ts`：`listen("claude-agent-event")` 已按 runId 过滤接收 chunk（L683-699）；`invoke` 单次 await 拿完整 result（L128-141），`enrichToolCall` 富化（L174）。`src/app/App.tsx` 只从最终 `result` 一次性写 `message.toolCalls`（L174-184）。渲染在 `chat-pane/index.tsx`（L86-92）+ `tool-call-card.tsx`。
- **SDK 事实**：工具名+完整入参在循环中的 `assistant` 消息即可得 → 「调用即冒卡」**不需要** `includePartialMessages`；只有「入参逐字打字机」才需要它 + `input_json_delta`。

**关键洞察**：真正动手的是「worker→Rust→前端的自有事件协议」这一层，而这一层**正是替换/接入其他 agent 客户端时唯一该稳定下来的契约缝**。

## Topic Axes

- A 事件传输链路（worker→Rust→前端的增量推送通道）
- B 卡片生命周期/状态（pending→running→success/error 中间态）
- C 展示与落库的关系（run 期 ephemeral 展示 vs done 固化 + redaction 时序）
- D 入参/出参获取粒度（整块 append-on-arrival vs token 级打字机）
- E 与文本/滚动的交互（时间序、auto-scroll、对账）
- F agent 客户端可插拔（Claude Code 可被 qwen 等替换；形态未定/混合）← refine 阶段引入

## 收敛前提（refine 结论）

接入形态「**还不确定/混合**」→ 按**最小公约数**设计：每个客户端 adapter 至少保证「拿到最终结果」，能流式的额外发增量事件，前端按**能力探测**选渲染策略，缺失能力自动退回 done 一次性。**不**现在就建多客户端基础设施（无具体客户端 = 过度设计），只把缝留干净。

## Ranked Ideas

### 1. 客户端无关的归一化工具事件契约
**Description:** 把 worker→Rust JSON-line 的工具事件定义成稳定 schema `{id,name,args,status,result,phase}`，由各客户端 adapter 产出；Rust + 前端永不感知背后是 Claude SDK 还是 qwen。Claude SDK worker 只是第一个实现。
**Axis:** A / F
**Basis:** `direct:` `claude-agent-worker.mjs:237-254` 的 `collectToolCalls` 产出的结构已接近这套 schema，提升为契约几乎零额外成本。
**Rationale:** 这层就是换客户端的抽象缝；先把它钉死，后续 adapter 只需对齐契约。
**Downsides:** 需明确禁止契约层泄漏 SDK 专有类型，要 code review 把关。
**Confidence:** 88% ｜ **Complexity:** 低-中 ｜ **Status:** Unexplored

### 2. done 权威 + 展示/落库分离（优雅降级地基）
**Description:** 流式事件只更新「进行中」assistant 消息的 UI 态；`done` 仍带完整 `toolCalls` 作唯一落库权威，结束按 id 对账覆盖。逐卡 redaction 在展示前做（递归叶子，复用 `redactSecretsInValue`）。
**Axis:** C / F
**Basis:** `direct:` `claude-agent-worker.mjs:322-328` done 已带完整数组；记忆「stringify→redact→parse 破 JSON」坑要求递归叶子红 action。
**Rationale:** 非流式客户端没有中途事件，done 是其唯一数据源——done 权威从「更稳」升级为「多客户端必需」；也避免中断/崩溃落库半截脏数据或泄漏未脱敏入参。
**Downsides:** 需要「按 id merge」的增量 updateAssistantMessage 逻辑。
**Confidence:** 85% ｜ **Complexity:** 中 ｜ **Status:** Unexplored

### 3. 工具卡片生命周期流式：调用即冒卡 → 跑完翻状态
**Description:** worker 在 `collectToolCalls` 更新时额外 emit `tool-call` 事件（use 发 running 骨架卡，result 按 id 更新 success/error+出参）；前端按 id append/更新。
**Axis:** B
**Basis:** `direct:` 循环内已实时累积，仅差中途 emit；`tool-call-card.tsx:9-38` 已支持折叠/状态。
**Rationale:** 直击诉求——长 run 多工具串行时消除「只有 waiting dots」的黑盒等待。
**Downsides:** running 中间态需新增（当前只有 use/result 两阶段）。
**Confidence:** 88% ｜ **Complexity:** 低-中 ｜ **Status:** Unexplored

### 4. 复用现有 emit+listen 通道，契约层不绑 SDK 类型 / 不迁 Channel
**Description:** 沿用 `emit_claude_event` + 前端 `listen` 模式，新增 `kind="tool-call"` payload；不重构成 Tauri `Channel<T>`；契约层禁止出现 `stream_event`/`SDKMessage`/`content_block_delta`。
**Axis:** A
**Basis:** `direct:` `commands.rs:436-489 / 551-567` chunk/session 已走通同构路径。
**Rationale:** 与现有流式文本同构、最小改动、零回归面；通道层天然客户端无关。
**Downsides:** payload 结构需容纳 tool-call 字段。
**Confidence:** 85% ｜ **Complexity:** 低 ｜ **Status:** Unexplored

### 5. 能力协商（capability flag）
**Description:** adapter 启动时声明能力（能否流式 tool 事件 / 能否流式 args / 能否报 running）。前端据此选渲染策略，缺失能力自动退回 done 一次性。
**Axis:** F
**Basis:** `reasoned:` 接入形态未定/混合 → 必须让强客户端发挥、弱客户端不被强求、且不为最弱者拉低体验。
**Rationale:** 让「同一前端 + 同一契约」适配差异巨大的后端，是可插拔的落地机制。
**Downsides:** 引入一点协商协议；需防止演化成过度配置。
**Confidence:** 72% ｜ **Complexity:** 中 ｜ **Status:** Unexplored

### 6. 新卡片出现时 auto-scroll 跟随 + run 结束清理订阅
**Description:** 卡片增量出现复用 chunk 的滚动跟随（`use-agent-run-controller` scrollContainerRef）；run 结束/中止时解绑 listener、running 残卡收敛为终态。
**Axis:** E
**Basis:** `reasoned:` 流式 UI 不跟随滚动会让卡片冒在屏幕外；现有 chunk 滚动逻辑可复用。
**Rationale:** 小但必要的体验收尾。
**Downsides:** 几乎无。
**Confidence:** 75% ｜ **Complexity:** 低 ｜ **Status:** Unexplored

### 7.〔DEFER·进阶〕input_json_delta 打字机入参
**Description:** 开 `includePartialMessages`，`content_block_start` 出空骨架，`input_json_delta` 逐片填入参，`content_block_stop` 标完成。
**Axis:** D
**Basis:** `external:` Claude Agent SDK streaming 文档（`includePartialMessages` + StreamEvent 时序）。
**Rationale / 为何 DEFER:** 这是耦合最深的 Claude-SDK 特性，多数非 Claude 客户端不支持；想法 3 的 append-on-arrival 已满足「看入参出参」诉求。改造成 adapter 可选能力，默认不做。
**Downsides:** partial JSON 累积 + emit 节流（防 IPC 洪泛）；客户端耦合。
**Confidence:** 55% ｜ **Complexity:** 中-高 ｜ **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | 移除 done、流式作唯一事实源 | 多客户端下 done 是最小公约数；非流式客户端无中途事件，去权威兜底=必崩 |
| 2 | 卡片与 assistant 文本按时间序交错（timeline） | scope 放大（当前卡片统一在文本前）；对非流式客户端无意义 → DEFER |
| 3 | 现在就建多客户端 adapter 注册表 / 多 worker 基础设施 | 无具体客户端，属过度设计；本轮只留干净的契约缝 |
| 4 | 为流式新建独立 Tauri Channel 子系统 | 与现有 emit+listen 重复，改动面大收益低 |

## 建议下一步

种子从「流式卡片」略微放宽为 **「客户端无关的 agent 工具事件契约 + 能力探测 + done 权威」**，流式工具卡片是它的第一个消费者。**范围红线**：本轮只实现流式卡片 + 留干净的缝（想法 1-6，7 DEFER），**不**预建任何多客户端机器。→ 进入 `ce-brainstorm`。
