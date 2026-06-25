# 大模型交互 eval 采集管道 — Requirements

- 日期：2026-06-25（含 ce-doc-review 修订）
- 来源：ce-ideate `docs/ideation/2026-06-25-eval-capture-vs-execution-log-ideation.md`
- 范围：Standard / Deep-feature（跨 Node worker + Rust + UI，含一次模块废弃）

## Outcome（一句话）

用一条「大模型交互 raw 采集」管道替换当前对用户无用的执行日志模块：每次调模型的 agent run 把模型的输出与系统提示原样存一条 eval 样本，落在独立、不随会话删、无上限的 JSONL store，并提供一个轻量入口取用/导出。

## Problem & Context

- 当前执行日志模块记的是**事件时间线**（里程碑/错误），且**截断 + 脱敏 + 10MB/会话上限 + 删会话即删**、UI 无导出 —— 对 eval 无用（boss 明确）。
- 真实对话虽在 `sessions.payload`，但同样是**脱敏+截断的显示态**、随会话删除消失，不能当 eval 源。
- 需求：一份 **raw、可长期累积、可导出** 的 eval 数据集，用于 ①建立大模型评估集 ②**为未来的「弱模型切换」回放回归门攒数据**（回放门本身需另起的 live 执行 harness 才成立——见 Scope 推迟；本期只负责采集其所需数据，不构成门本身）。

## Users & Value

- 用户：单人（boss/开发者），用于改进大模型评估。
- 价值：随使用自然累积的带弱标签 raw 数据集 → 支持离线的 prompt/模型对比，并为"切弱模型"的数据驱动 go/no-go **攒下所需数据**（判定门本身待 live 回放 harness）。

## Functional Requirements

- **R1 采集点**：在 worker 的 SDK 边界（`src-node/claude-agent-worker.mjs`）采集，**在任何 redact/truncate 之前**。worker 能拿到自拼的 `systemPrompt` 与**本轮**完整的 SDK 输出流（assistant/tool_use/tool_result，已核实）。**注意**：触发前的历史对话 worker 只持有有损摘要（见 R3 `input.messages` 与「保真边界」），不是逐轮原生 blocks。
- **R2 样本粒度**：**Run 级** —— 一次 submitIntent 触发的完整 agent run（一次 `query()`）为一条记录，内含按顺序的全部轮次流（无损，turn 级可后期从中切分）。
- **R3 单条样本内容与形状**（一行一 run，JSONL）。schema 已敲定：
  - **消息表示**：用 **Anthropic 原生 content-blocks**（`{type:"text"|"tool_use"|"tool_result", ...}`）。
  - **raw 边界**：`input.system` 与 `output.*`（本轮模型产出）为 **raw、不截断、不脱敏**；`input.messages` 的**历史部分是 worker 持有的有损摘要**（见下）。
  - **input / output 切法**：
    - `input.system`：当时实际组装的完整 systemPrompt（骨架 + 注入的 SKILL.md + 场景 reference + 上下文）
    - `input.toolsHash`：当时可用 MCP 工具定义的指纹（全量定义本期不落盘，见 R5b）
    - `input.messages`：本轮用户输入 + worker 实际持有的会话上下文（`conversationContext`：最近 6 条、每条截 260 字、剥掉工具行的 prose 摘要）。**这是历史对话的有损摘要、非逐轮原生 blocks**——原始历史在 SDK 会话（`claudeSessionId`）里，worker 看不到。eval 消费方不得假设 input 侧有逐轮保真度。
    - `output.messages`：本轮模型产出的完整 assistant/tool_use/tool_result 序列（原生 blocks，未截断）
    - `output.finalText`：本轮最终 assistant 文本
  - **label**：取 **worker 内 apply/validate 工具结果携带的 verification**（`{ok, caliber, errors}`，采集点即可拿到）；拓扑以外的 run 为 `null`。**注意**：确认时（确认按钮）由 Rust 层 `verify_topology` 产出的口径是**另一个、更晚的、worker 退出后才有的结论，本期不采**——二者可能不一致，label 指的是前者。
  - **label 是"必要非充分"的结构闸**：`structural_only` 只验连通/可达，**结构对但语义错**（如把双平面需求做成 4 交换机环、节点数不对）也会判 `ok=true`。真正可用的 eval 还需额外的意图/场景符合度信号——留给离线 harness，不由本数据集承诺。
  - **fingerprint**：SKILL.md 内容 hash + **骨架版本**（= `SYSTEM_PROMPT_SKELETON` 内容 hash，与 SKILL.md hash 同法）+ 场景 id + model id。
  - **元数据**：schemaVersion、runId、sessionId、claudeSessionId、stage、scenarioConfigId、createdAt、durationMs。
- **R4 采集范围**：**任何 submitIntent 触发的模型调用都采**（拓扑以外的自由问答也采，只是 label 为 null）。纯本地生成、不调模型的路径（如时间同步默认摘要）不产生记录。
- **R5 存储**：独立 eval store，**append-only JSONL**，**不**挂在 `logs/sess-<id>/` 下、**无**大小上限、**删会话不删**，与会话生命周期解耦。落盘约束：
  - 文件权限 **0600**（仅属主读写）；放在**不被 iCloud/Dropbox/Time Machine 默认同步**的目录（如 app-config 下的 `eval/`）。
  - eval store 路径**必须排除在既有 session 导出/文件选择面之外**——既有去标识导出或任何遍历 app-data 的面**不得包含 eval store**（否则未脱敏密钥会经既有导出外泄，违背"不分享"身份边界）。
- **R5b 工具定义指纹（快照推迟）**：本期记录里**只留 `input.toolsHash` 指纹**（满足"当时有哪些工具"的分组/审计）。MCP 工具**全量定义快照的落盘随回放工具链一起推迟**（见 Scope）——回放需要全量定义时再补。
- **R6 隐私姿态**：eval 路径**采集存原文、导出也原文**，全程不脱敏。脱敏**只保留在 agent↔用户交互（聊天展示 + 回喂模型的会话上下文）那一层**。**这是有意的单向门**：导出永不脱敏意味着任何未来的分享/复现路径必须在下游另加去标识步骤（既有 deidentified 导出管道是天然接缝），reversing 需重处理已积累的 raw JSONL。
- **R7 取用/导出**：提供一个**轻量入口**（菜单/命令级的「打开 eval 目录」或「导出数据集」）。磁盘格式即 JSONL 数据集，导出≈定位文件。入口具体落点在 planning 定。**配套**：提供**清空 / 删除某会话 eval 记录**的手动入口（隐私兜底，见 R8 删除告知）。
- **R8 废弃执行日志模块**：删除 `src-tauri/src/diagnostic_store.rs`、`src-tauri/src/log_file_writer.rs`、`src/ui/diagnostics/DiagnosticsDrawer.tsx`（及其前端 repo 使用）、三个 Tauri 命令（`append_diagnostic_log` / `list_diagnostic_logs` / `clear_session_diagnostic_logs`），清理/改写 `logDiagnostic` 调用点。**删除牵连面**（不止上述）：
  - `session_store.rs` 的 `remove_session` 签名/体——去掉 `DiagnosticStore` 入参与 `clear_logs_for_session_fs` 调用；
  - `lib.rs` 的 `.manage(DiagnosticStore)` 注册；
  - 确认 `redaction.rs` 在 diagnostic_store 删除后仍独立自洽（其共享 redact 行为原从 diagnostic_store 抽出）。
  - **删会话不删 eval**：删会话时或设置里需**明示**"eval 记录不随会话删除"，配合 R7 的手动清除入口。
  - 旧 jsonl 日志不迁移（已截断脱敏不可恢复），干净切换。

## Scope Boundaries

**本期做**：R1–R8（含 R5b）—— 采集管道 + 独立 store + 轻量导出入口 + 废弃旧日志模块。

**推迟（靠导出的数据集离线做）**：
- app 内置的 eval-run / 打分 harness
- Langfuse 式 trace→dataset 精选/标注 UI
- **live 回放回归工具链 + 工具定义全量快照**（回放需对 live sidecar/DB 重跑工具调用——见下「保真边界」；本期只保证数据采得到、导得出）

**身份外（不做）**：
- 把 app 变成 eval 平台 / 服务端遥测
- 任何上传 / 分享 / 联网外发（保持本地单机）

## Success Criteria

- 每次"调了模型"的 submitIntent 都产出 1 条符合 R3 的样本（`input.system`/`output` raw，`input.messages` 历史为摘要）。
- 样本在删除会话后仍在、且无大小上限；eval store 文件 0600 且不在同步目录、不被既有导出遍历。
- 执行日志模块完全移除（含 `remove_session`/`lib.rs` 牵连），vitest + cargo + biome 全绿。
- boss 能从一个 UI 入口打开 eval 目录 / 导出 JSONL，喂给离线 harness；并能手动清除某会话/全部 eval。

## Dependencies / Assumptions

- **已核实**：worker 能拿到 `systemPrompt` + 本轮完整 SDK 输出流（assistant/tool_use/tool_result）。
- **保真边界（重要）**：
  - `input.messages` 历史侧只有有损摘要（`conversationContext`），非逐轮原生 blocks——原始历史在 SDK 会话内、worker 不可见。
  - "回放回归门"需 **live 执行 harness**：换模型回放会产生**新的工具调用**，需对 live sidecar/DB 现跑才有结果；记录里的 `output.messages` 是旧模型的 tool_results，新模型用不上。故本期数据**不能直接当门**，只为未来的门攒料（goal② 已据此降级）。
- **假设（boss 已接受）**：eval store 本地落原文（含敏感 prompt）可接受——单用户桌面、本地、不外发。
- **假设**：本期 eval store **默认无上限、无自动 rotate**，靠 R7 手动清除（含密钥原文，须配合 0600 + 非同步目录 + 排除导出）。长期是否加 rotate 见 Open Questions。
- **接受的风险（R8 同期直接删，boss 定）**：删旧日志模块与新采集同期落地，存在"新采集未经长期实战即删旧观测性"的盲飞窗口，且**调模型前就失败的 run（auth 失败 / worker 崩 / 意图被拒）本期两边都不留记录**——这是已知的告知式缺口，本期接受。
- **约束**：verification 弱标签只在拓扑 run 有；其它阶段样本无标签。
- **待确认**：所有调模型的路径是否都经 `claude-agent-worker.mjs`（无其它直连 SDK 的调用点）——planning 前需 grep 确认，否则 R4"全采"承诺会被静默违背。
- **净新计算**：`toolsHash`、`skillHash`、骨架版本 hash 都是 worker 内新增的派生值（SKILL.md 内容已在 `buildSystemPromptForStage` 读到、工具列表已在 `buildAllowedToolsForStage` 构建），planning 需估这部分工作量。

## Open Questions（留给 planning）

- R7 入口落点：旧 drawer 删了，导出/打开目录/清除入口放哪（设置页？头部按钮？命令？）。
- 长期保留策略：是否加上限/rotate（本期默认不做、手动清）。
- 是否顺带存 token usage/cost 每条（廉价加项，planning 定）。
- R5 store 落盘归属：worker 直写（worker 已有直写 audit 文件的先例）还是经 Rust sidecar——planning 定。
