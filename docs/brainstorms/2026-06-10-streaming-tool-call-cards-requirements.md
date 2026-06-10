---
date: 2026-06-10
topic: streaming-tool-call-cards
---

# 流式工具调用卡片：客户端无关事件契约 + 推理过程中实时展示

## Summary

agent 运行过程中，工具一被调用就以「运行中」卡片出现在对话流（带完整入参），执行完就地翻成成功/失败并补出参。事件沿现有 worker→Rust→前端逐行通道扩展一种客户端无关的工具事件类型；run 结束仍由 `done` 一次性对账，并保持唯一落库权威。

## Problem Frame

当前工具卡片在一次推理完整结束后才一次性渲染。长 run 多工具串行时，用户全程只看到等待动画，agent 在做什么完全是黑盒。

另一个背景约束：后续可能用 qwen 等其他 agent 客户端替换 Claude Code 后端，接入形态未定。worker→Rust→前端这条自有事件协议层，是替换后端时需要稳定的契约缝之一（本轮只覆盖工具事件这一段；prompt 构建、技能注入、会话恢复、阶段结果提取等仍是后端专有面，换后端时需另行适配）。因此工具事件契约必须客户端无关，不能绑死 Claude Agent SDK。

---

## Key Decisions

- **工具事件契约客户端无关**。流式事件 schema 固定为 `{id, name, args, status, result, phase}`，由各 agent 后端的 worker 产出；Rust 与前端不感知背后是哪个 SDK。Claude SDK worker 只是该契约的第一个实现。
- **隐式降级，不做能力协商协议**。前端只认事件：流式工具事件到达就增量渲染，整个 run 没有到达就等 `done` 一次性出卡。未来非流式后端不发事件即自动降级，零协议面。
- **`done` 是唯一落库权威**。流式事件只驱动「进行中」消息的 UI 态；run 正常结束时按 `id` 对账，以 `done` 携带的完整工具调用列表覆盖并落库。避免中断时落半截脏数据，也让非流式后端天然成立。
- **沿现有事件通道扩展，不新建传输机制**。worker→Rust 的行协议与 Rust→前端的事件广播已承载流式文本，本次只新增一种事件类型，不引入新通道。
- **异常终止丢弃**。当前产品不存在用户主动停止入口（唯一中途终止是 Rust 侧 300 秒超时强杀，等同崩溃路径）。worker 崩溃/超时没有 `done`，已展示卡片随错误消息丢弃，与现状一致。用户停止能力及其对账语义推迟到停止功能立项时一并设计。

---

## Requirements

**契约**

- R1. 流式工具事件 schema 为 `{id, name, args, status, result, phase}`，字段语义与 agent 后端实现无关；`phase` 取值 `start`（调用开始：`args` 完整，无 `status`/`result`）或 `result`（结果到达：`status` 取 `success`/`error`，附 `result`）。
- R2. `phase` 仅存在于流式中间事件；`done` 携带的工具调用列表与落库记录保持现有五字段结构 `{id, name, args, status, result}`。
- R3. Rust 与前端层不得出现 Claude SDK 专有类型（如 `stream_event`、`SDKMessage`、`content_block_delta`）。
- R4. 整个 run 未收到任何流式工具事件时，前端在 `done` 后一次性渲染全部卡片，最终展示与流式路径一致。

**流式展示**

- R5. `start` 事件到达时，对话流立即出现「运行中」卡片，含工具名与完整入参；折叠态摘要复用现有入参显著字段逻辑。
- R6. worker 仅在完整入参可用时发出 `start` 事件（不转发空入参的早期信号）；前端对工具事件按 `id` upsert，重复事件就地合并，不追加新卡。
- R7. `result` 事件到达时，对应卡片就地翻成成功/失败终态并补出参。
- R8. 流式工具事件在前端到达时立即递归叶子脱敏，脱敏后才进入任何内存状态；与落库路径使用同一脱敏机制。
- R9. 卡片状态机新增「运行中」视觉态，与既有成功/失败并列。
- R10. 新卡片出现时滚动跟随沿用现有流式文本策略；用户主动向上滚动时不强制拉回。
- R11. invoke 返回后（无论成功或失败）统一清理事件订阅，并将残余「运行中」卡片按对账（R12）或丢弃（R14）收敛，不留运行中残卡。

**落库、对账与诊断**

- R12. run 正常结束时按 `id` 对账：`done` 列表覆盖流式期间的 UI 态并作为唯一落库来源；对账就地更新已渲染卡片、保持出现顺序，不整体重排。
- R13. 新工具事件的诊断日志只记录非敏感元数据（工具名、`id`、`phase`、字节数），不得包含原始 `args`/`result`。
- R14. worker 崩溃/超时（无 `done`）时，已展示卡片随错误消息丢弃，不落库。

---

## Key Flows

- F1. 正常流式 run
  - **Trigger:** 用户提交需求，agent 开始运行并调用工具。
  - **Steps:** `start` 事件到达 → 出现「运行中」卡片（含入参）→ `result` 事件到达 → 卡片翻终态补出参 →（多工具依次重复）→ `done` 到达 → 按 `id` 对账落库。
  - **Covers:** R1, R5, R7, R12
- F2. 非流式后端降级
  - **Trigger:** agent 后端整个 run 不发流式工具事件。
  - **Steps:** 前端等待 → `done` 到达 → 一次性渲染全部卡片并落库。
  - **Covers:** R4, R12
- F3. worker 崩溃/超时
  - **Trigger:** worker 异常退出或超时强杀，无 `done`。
  - **Steps:** 展示错误消息 → 已流式展示的卡片丢弃，不落库 → 清理订阅。
  - **Covers:** R11, R14

---

## Acceptance Examples

- AE1. **Covers R5, R7.** Given 一次 run 串行调用两个工具，When 第一个工具开始执行，Then 其「运行中」卡片（含完整入参）立即出现；第二个工具开始前，第一个卡片已翻成功并带出参。
- AE2. **Covers R6.** Given worker 对同一工具调用先后发出两条 `start` 事件，Then 对话流中仅出现一张卡片（按 `id` 就地合并）。
- AE3. **Covers R4.** Given 后端整个 run 未发任何流式工具事件，When `done` 到达，Then 全部卡片一次性出现，内容与流式路径渲染结果一致。
- AE4. **Covers R8.** Given 工具入参含敏感值（如 `Authorization` 头），When 「运行中」卡片出现，Then 入参中的敏感值已脱敏。
- AE5. **Covers R11, R14.** Given run 进行中已展示若干卡片，When worker 崩溃，Then 展示错误消息，无运行中残卡，重开会话后该条消息无任何卡片。
- AE6. **Covers R12.** Given 流式期间因事件丢失少渲染了一张卡片，When `done` 到达对账，Then UI 与落库结果均以 `done` 列表为准补齐。

---

## Scope Boundaries

- 用户主动停止能力（含「中断」状态及其对账语义）——当前产品不存在停止入口，属净新增的三层链路（前端入口 → Rust 停止命令 → worker 优雅中断），推迟到停止功能立项时一并设计。
- 入参打字机（`input_json_delta` 逐字填充）——耦合 Claude SDK 最深，推迟。
- 卡片与 assistant 文本按时间序交错（timeline 形态）——推迟，当前保持卡片统一在文本前。
- 能力协商协议（capability flag）——已否决，由隐式降级替代。
- 多客户端 adapter 注册表 / 多 worker 基建——无具体客户端前不预建，本轮只保证契约层干净。
- 崩溃时尽力落库前端内存中的卡片——已否决，保住 `done` 唯一落库权威。
- 传输层迁移到 Tauri `Channel`——已否决，沿用现有事件通道。

---

## Dependencies / Assumptions

- 已核实：当前不存在用户停止路径，唯一中途终止是 Rust 侧 300 秒超时对进程组 SIGKILL（`src-tauri/src/commands.rs`），属 F3 崩溃路径。
- 已核实：worker stdout → Rust 行读取 → 前端事件广播链路保序，卡片时序由事件到达顺序保证。
- `done` 经 invoke 返回值（而非事件通道）到达前端，对账实现需处理两条路径的汇合时序。

---

## Outstanding Questions

**Deferred to Planning**

- 「运行中」视觉态的具体样式，以及运行中卡片默认折叠还是展开。
- 对账时按 `id` merge 的具体实现位置（消息更新路径），含 invoke 返回与事件通道的汇合时序。

---

## Sources

- `docs/ideation/2026-06-10-streaming-tool-call-cards-ideation.md`——本需求的上游 ideation，含 7 个候选想法与否决理由。
- `docs/brainstorms/2026-06-09-tool-call-display-requirements.md`——前置功能（一次性渲染的工具卡片）的需求文档。
- 现状代码定位：worker 收集与回传 `src-node/claude-agent-worker.mjs`；Rust 逐行处理与事件广播 `src-tauri/src/commands.rs`；前端适配 `src/agent/agent-adapter.ts` 与 `src/agent/tool-call-record.ts`；卡片渲染 `src/app/components/chat-pane/`；落库 `src/sessions/session-repository.ts`。
