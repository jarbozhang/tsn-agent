---
title: "feat: 用户终止推理（发送键变终止 + 顶部 loading 下沉）"
date: 2026-06-25
type: feat
status: planned
origin: docs/ideation/2026-06-18-topology-confirmation-skill-ideation.md（点子 #8）
---

# feat: 用户终止推理

## 摘要

推理进行时让用户能**主动停掉当前这轮推理**，而不是干等到自然结束或 300 秒超时。配套把顶部那条全局 loading banner 撤掉、状态文案下沉到输入框区，输入框推理中保持可输入，发送按钮在推理态切成「终止」。

后端复用已有的、经单测验证的进程组强杀逻辑（不重写），加一个全局 worker handle 存储 + 一个 `cancel_claude_agent(runId)` 命令；前端把 runId 提到 submitIntent 生成并留存，终止时按 runId 调命令杀进程，已流式产出的内容保留并标注「已终止」。

这是 ideation 点子 #8 的完整落地——之前只停在 ideation、被显式 defer（"现在根本没有终止 agent 的能力"），没进任何 plan。

---

## 问题背景

当前一次推理是前端一个 `await invoke("run_claude_agent")`，全链路没有任何中断句柄：

- 后端 `run_claude_agent_blocking`（`src-tauri/src/commands.rs`）spawn worker 进程后进入 100ms 轮询 `try_wait()` 的等待循环，child handle 是函数局部变量、不存全局，外部命令拿不到它去 kill。唯一的中途终止是 300 秒超时强杀。
- 前端 `useAgentRunController`（`src/app/hooks/use-agent-run-controller.ts`）只有 `isAgentRunning/agentRunPhase`，没有 cancel 字段；发送按钮 `disabled={isAgentRunning||!input.trim()}`，推理中只会灰显。
- 顶部 banner `AgentRunStatusBar` 渲染在 `src/app/App.tsx`，离用户注意力中心（输入框）远，反馈弱。

结果：长任务跑偏了，用户只能等超时或硬刷新。

**已有可复用的基础设施**（这是本计划成立的关键）：
- runId 全链贯通——前端 `createRunId()` 生成 → 随 request 传入 → 后端 `request.run_id` 接住（`commands.rs`）。可用 runId 精准定位 worker。
- 进程组强杀逻辑已存在且有单测：Unix `process_group(0)` 设组 + `libc::kill(-pgid, SIGKILL)`；Windows `taskkill /F /T /PID`（`commands.rs` 超时分支 + `process_group_kill_terminates_member_process` 测试）。
- 单例锁 `ClaudeAgentRunGuard`（AtomicBool）保证同时只有一个 run → 全局存储用 `Mutex<Option<...>>` 即可，不需要 map。

---

## 需求

| ID | 需求 | 来源 |
|----|------|------|
| R1 | 推理进行时移除顶部全局 loading banner，状态文案下沉到输入框区 | ideation #8 |
| R2 | 推理运行态（`isAgentRunning` 等）保留不变，仅改变其呈现位置 | ideation #8 |
| R3 | 「描述你的 TSN 需求」textarea 推理中仍可输入（维持现状，不回退） | ideation #8 |
| R4 | 发送按钮在推理态切成「终止」按钮（推理中可点，非灰显） | ideation #8 |
| R5 | 点击终止能真正停掉当前这轮推理（杀掉 worker 进程组） | ideation #8 |
| R6 | 终止后保留已流式产出的部分回复，末尾标注「已终止」，并落库持久化 | 本次决策 |
| R7 | 终止用 `SIGKILL` 直接复用现有强杀逻辑（不引入 SIGTERM 优雅退出） | 本次决策 |
| R8 | 状态文案下沉后保留「已运行 N 秒」计时 | 本次决策 |
| R9 | 单测覆盖后端杀进程/注册表 + 前端终止编排与按钮切换；终止全链路有自动化集成测试 + 真机验收 | boss 要求 |

---

## 关键技术决策

### KTD1：后端用 `Mutex<Option<ActiveWorker>>` 存 worker handle，cancel 命令按 runId 比对后杀进程组，**返回是否真杀到**

新增一个 Tauri-managed state（`AgentWorkerRegistry`），内部 `Mutex<Option<ActiveWorker>>`，`ActiveWorker { run_id, pgid（Unix）/ pid（Windows） }`。

**注册时机（硬约束，doc-review 抓的漏注册窗口）**：`run_claude_agent_blocking` 拿到 pgid 后**必须紧接着 `registry.replace(...)` + 构造 RAII guard，且早于 `child.stdout.take()?`/`child.stderr.take()?` 这两个 `?` 早返回**——否则 take 失败会留下「已 spawn 但未注册」的孤儿 worker，cancel 杀不到。RAII guard 在函数任意返回路径（成功/超时/失败）清空，与现有 `ClaudeAgentRunGuard` 同模式。

**去注册紧贴 reap（doc-review 抓的 pgid 复用窗口）**：轮询循环一旦 `try_wait()` 返回 `Some`（进程已退出、zombie 已收割），**立即在同一把锁下 `registry.take()`**，不拖到函数末尾 RAII 才清。把「已 reap 但未去注册」的窗口压到几条指令内。

`cancel_claude_agent(run_id) -> Result<CancelOutcome, String>`：锁 registry，
- `Some(w)` 且 `w.run_id == run_id` → 杀进程组、返回 `{ killed: true }`；
- 否则（无运行 / runId 不匹配 / run 已自然收尾或已注册去除）→ 返回 `{ killed: false }`，不报错（幂等）。

**`killed` 语义是前端区分「真终止」与「没杀到」的唯一依据**（见 KTD3）。Unix 杀进程前先 `libc::kill(-pgid, 0)` 探活，pgid 已不存在则不发 SIGKILL（防 reap 后 pgid 复用误杀第三方进程组）。

**杀进程逻辑抽成单一 helper**（`kill_worker_process_group`），超时分支与 cancel 命令共用，杜绝双轨复制（遵循「拒绝冗余兼容代码、单路径」）。

### KTD2：cancel 命令只发信号，不 `wait()`——复用阻塞循环的既有回收

worker 被杀后，`run_claude_agent_blocking` 的轮询循环下一拍 `try_wait()` 返回 `Some(非零退出)` → break → 后续 `try_wait()` 收割 zombie（现有代码路径）。cancel 命令不拥有 child handle，不需要也不应 `wait()`，避免双重 own。防僵尸由既有循环负责。

### KTD3：「被杀 → 用户终止」的识别放前端，但以 cancel 命令的 `killed:true` 为唯一闸门

worker 被 SIGKILL → 进程非零退出 → `run_claude_agent_blocking` 返回 `Err` → `invoke` reject → `runTsnAgent` 的 catch **吞错返回失败态 result**（不抛出，且该 result 自带一条 `event-agent-failed` 错误 event + `buildAgentFailureText`）→ 回到 `submitIntent` 成功分支。

前端据此把消息塑形成「已终止」。但**不能只凭「我点过终止」就标已终止**（doc-review 抓的误标窗口）——必须以 `cancel_claude_agent` 返回的 `killed:true` 为准：

- `handleTerminateRun` 调 cancel，**仅当返回 `killed:true` 才置 `cancelRequestedRef`**。`killed:false`（worker 尚未注册的早窗 / run 已自然收尾 / 真崩溃同一拍）→ 不置标志、给一句轻提示，让正常或失败路径照走。这一步同时堵住：worker 注册前点击、真崩溃与点击同瞬、confirm-stage 快路径点击三个误标场景。
- 终止塑形必须**同时处理两路**：assistant 消息 content 用 `streamedText` + 「已终止」标记；**且丢弃 `result.events`**（不把 `event-agent-failed` append 进 `agentEvents`）、不消费 `buildAgentFailureText`。否则事件流会同时出现「已终止」消息和「执行失败」事件，自相矛盾。

**后端无需新增 cancelled 标记协议**，`killed` 布尔即足够——单路径、改动最小。

### KTD4：runId 在 submitIntent 生成并留存，传入 runTsnAgent

终止按钮要在推理途中拿到当前 runId 去调 cancel。当前 runId 在 `runTsnAgent` 内部生成（`request.runId ?? createRunId()`）。改为：导出 `createRunId`，`submitIntent` 生成 runId → 存入 `activeRunIdRef` → 传入 `runTsnAgent` 的 `request.runId`。runId 由编排层单一拥有，前后端仍是同一个值。

---

## 高层技术设计

终止时各组件/进程的协作（跨 UI → Tauri 命令 → worker 进程 → 阻塞循环 → 回到 UI）：

```mermaid
sequenceDiagram
    participant U as 用户
    participant CP as ChatPane（终止键）
    participant App as submitIntent / refs
    participant Cancel as cancel_claude_agent 命令
    participant Reg as AgentWorkerRegistry
    participant Loop as run_claude_agent_blocking 循环
    participant W as worker 进程组

    Note over App,W: 推理进行中：activeRunIdRef=runId，Loop 已注册到 Reg
    U->>CP: 点「终止」
    CP->>App: onTerminate()
    App->>Cancel: invoke(cancel_claude_agent, runId)
    Cancel->>Reg: 锁定，比对 runId
    Reg-->>Cancel: ActiveWorker{pgid}
    Cancel->>W: kill(-pgid,0) 探活 → kill(-pgid, SIGKILL)（复用 helper）
    Cancel-->>App: { killed: true }
    App->>App: killed 为真 → cancelRequestedRef=true（false 则轻提示、不标记）
    Reg->>Reg: loop try_wait()=Some → 同锁下 registry.take() 去注册
    W-->>Loop: 进程非零退出
    Loop->>Loop: 收割 zombie → 返回 Err
    Loop-->>App: invoke reject → runTsnAgent catch 吞错返回失败态 result
    App->>App: cancelRequestedRef 为真 → streamedText+已终止塑形、丢弃 result.events、落库
    App->>CP: 渲染保留内容 + 「已终止」，运行态收尾（finishRun）
```

---

## 实现单元

### U1. 后端：worker handle 注册表 + `cancel_claude_agent` 命令

**Goal**：让外部命令能按 runId 定位并杀掉正在跑的 worker 进程组，复用既有强杀逻辑。

**Requirements**：R5, R7, R9

**Dependencies**：无

**Files**：
- `src-tauri/src/commands.rs`（新增 `AgentWorkerRegistry` state、`ActiveWorker` struct、RAII 注册 guard、`kill_worker_process_group` helper、`cancel_claude_agent` 命令；超时分支改为调用 helper；测试同文件 `#[cfg(test)]`）
- `src-tauri/src/lib.rs`（`generate_handler!` 注册 `cancel_claude_agent`；`.manage(AgentWorkerRegistry::default())`）

**Approach**：
- `ActiveWorker { run_id: String, #[cfg(unix)] pgid: i32, #[cfg(windows)] pid: u32 }`；registry `Mutex<Option<ActiveWorker>>`；`CancelOutcome { killed: bool }`（serde 序列化给前端）。
- 抽 `kill_worker_process_group(&ActiveWorker)`：内含 `#[cfg(unix)]` 先 `libc::kill(-pgid, 0)` 探活、存活才 `libc::kill(-pgid, SIGKILL)` / `#[cfg(windows)] taskkill /F /T /PID` 两分支。超时分支（`commands.rs` 现 line ~271）改为构造 `ActiveWorker` 或直接调 helper，消除复制。
- `run_claude_agent_blocking` **注册顺序（硬约束）**：spawn 成功 → 取 `worker_pgid`（现 line ~242）→ **立即** `registry.lock().replace(ActiveWorker{...})` 并构造去注册 RAII guard，**这一步必须早于 `child.stdout.take()?` / `child.stderr.take()?`**（现 line ~244-251），否则 take 失败留下未注册孤儿。
- **去注册紧贴 reap**：轮询循环 `try_wait()` 返回 `Some` 时（现 line ~270 break 前），同锁下 `registry.lock().take()`；RAII guard 作为兜底再清一次（已 None 则 no-op）。单例锁保证 registry 至多一条。
- `cancel_claude_agent(registry: State, run_id: String) -> Result<CancelOutcome, String>`：锁 registry → `Some(w) if w.run_id == run_id` → 调 helper、`take()` 该槽、返回 `Ok(CancelOutcome{killed:true})`；否则 `Ok(CancelOutcome{killed:false})`（幂等、非错误）。**不** `wait()`（KTD2，回收由阻塞循环负责）。

**Patterns to follow**：`ClaudeAgentRunGuard` 的 RAII（`commands.rs`）；超时分支现有 kill 两平台写法；`process_group_kill_terminates_member_process` 测试搭进程组的方式。

**Test scenarios**（`src-tauri/src/commands.rs` `#[cfg(test)]`）：
- register 后 `cancel` 匹配 runId → 返回 `killed:true`、目标进程组成员被回收（复用 sleep 子进程 + `libc::kill(member,0)==ESRCH` 轮询断言，仿 `process_group_kill_terminates_member_process`）。
- `cancel` 传不匹配 runId → `killed:false`、不 panic、不误杀（spawn 进程组、用错 runId cancel、断言成员仍存活）。
- registry 为空时 `cancel` → `killed:false`，幂等。
- 探活：对一个已退出（pgid 不存在）的 ActiveWorker 调 helper → 不发 SIGKILL（探活返回不存在即跳过），不误杀。
- 去注册：模拟 reap 后同锁 `take()` → registry 归 `None`；RAII guard 兜底对已 None 槽 no-op 不 panic。
- helper 跨平台编译：Unix 路径单测覆盖；Windows 分支保证 `#[cfg(windows)]` 编译（CI 1.96 不在 Windows 跑，靠类型检查）。

**Verification**：`cargo test` 全绿；新命令出现在 `generate_handler!`；超时分支与 cancel 共用同一 helper（grep 确认无两处 `libc::kill(-` 复制）。

---

### U2. 前端：runId 提升 + 终止编排 + 「已终止」消息塑形

**Goal**：submitIntent 生成并留存 runId，提供 `handleTerminateRun` 调 cancel 命令，终止后保留已产出内容并标注「已终止」落库。

**Requirements**：R2, R5, R6, R7, R8

**Dependencies**：U1

**Files**：
- `src/agent/agent-adapter.ts`（导出 `createRunId`）
- `src/app/App.tsx`（submitIntent 生成 runId、`activeRunIdRef`/`cancelRequestedRef`、`handleTerminateRun`、终止分支塑形、finally 重置）
- `src/app/App.test.tsx`（终止编排测试）

**Approach**：
- 导出 `createRunId`（agent-adapter.ts 现 line 1112，未导出）。
- `submitIntent`：`const runId = createRunId(); activeRunIdRef.current = runId;`；`runTsnAgent({ ..., runId })`（`runTsnAgent` 的 `request.runId ?? createRunId()` 复用该值，前后端同 runId）。维护一个本闭包内的 `settled` 标志（见 late-chunk 守卫）。
- `handleTerminateRun`（KTD3 的 `killed` 闸门）：
  ```
  const runId = activeRunIdRef.current;
  if (!isAgentRunning || !runId) return;
  try {
    const { killed } = await invoke("cancel_claude_agent", { runId });
    if (killed) cancelRequestedRef.current = true;       // 仅真杀到才标记
    else { /* 轻提示：推理尚未就绪/已结束，未能终止；不置脏标志 */ }
  } catch { /* invoke 自身失败：不留脏标志，照常等本轮结束 */ }
  ```
  **关键**：`cancelRequestedRef` 只在 `killed:true` 时置位（堵 doc-review 的三个误标窗口：worker 注册前点击 / 真崩溃同瞬 / confirm-stage 快路径点击）。
- `runTsnAgent` 返回后分支（在现成功路径内）：
  - `cancelRequestedRef.current` 为真 → 先置 `settled = true`（挡 late chunk）→ 构造 terminated 消息：content = `redactProviderNamesForDisplay(streamedText)`（空则纯「已终止」标记），末尾追加「已终止」标记；`toolCalls: [...streamedToolCalls.values()]`；`workflow` 取 `result.workflow`（catch 返回未变更 effectiveWorkflow）。**丢弃 `result.events`**（不把 `event-agent-failed` append 进 `agentEvents`）、**不**消费 `buildAgentFailureText`。落库 `repository.save`（R6）。
  - 否则走现有正常塑形（不变）。
- **late-chunk 守卫**（doc-review）：`onChunk` 开头 `if (settled) return;`——SIGKILL 后在途 chunk 不得覆盖已塑形的「已终止」消息（现 `runFinished` 只挡 onToolCall、不挡 onChunk）。
- `finally`：`activeRunIdRef.current = undefined; cancelRequestedRef.current = false; agentRun.finishRun();`。
- 「已运行 N 秒」（R8）：`agentRunElapsedSeconds` 已有，U3 传给 ChatPane 即可，本单元不动计时逻辑。
- 终止标记文案只说「已终止」，**不**声称「工程保持原状」：`apply_operations` 是单事务（强杀中途未 commit 即回滚、无半应用损坏），但已 commit 而未回传的有效变更可能不反映在本轮 session（下次快照可见）——不做虚假承诺。

**Patterns to follow**：submitIntent 现有 `updateAssistantMessage` / `nextSession` 塑形与 `repository.save`；`redactProviderNamesForDisplay` 脱敏；refs 用 `useRef`（避免 async 闭包读 state 过期，KTD3）。

**Test scenarios**（`src/app/App.test.tsx`）：
- 终止保留内容：mock invoke 使 `run_claude_agent` 先经 onChunk 吐「部分内容」再 reject、`cancel_claude_agent` 返回 `{killed:true}`；调 `handleTerminateRun` → 断言最终 assistant 消息含「部分内容」+「已终止」、**不**含「生成失败」、`repository.save` 被调用持久化。
- 终止不留失败 event：上一场景断言 `nextSession.agentEvents` **不含** `kind:'error'`/`event-agent-failed`。
- `killed:false` 不误标：`cancel_claude_agent` 返回 `{killed:false}`（早窗/已结束）→ 断言 `cancelRequestedRef` 未置、本轮若失败仍显示「生成失败」、若成功仍正常塑形。
- 真失败不误标：invoke reject 且从未点终止（`cancelRequestedRef` 假）→ 仍显示「生成失败」（回归保护）。
- invoke 自身 reject：`cancel_claude_agent` 抛错 → `cancelRequestedRef` 不残留脏标、不抛未捕获 rejection。
- late chunk：塑形「已终止」（settled=true）后再来一个 chunk → 不污染最终消息。
- runId 一致：传入 `runTsnAgent` 的 runId == `cancel_claude_agent` 收到的 runId == `activeRunIdRef`。
- `handleTerminateRun` 守卫：未运行 / `activeRunIdRef` 空时点击 → 不 invoke、不抛错。
- finally 重置：一轮终止后 refs 归位，下一轮正常提交不被污染。

**Verification**：`vitest run` 全绿；终止后刷新（reload）消息仍在；事件流无「执行失败」残留。

---

### U3. 前端：撤顶部 banner + 状态下沉输入框区 + 发送键切终止

**Goal**：移除顶部全局 banner，把状态文案（含秒数）放进输入框区，发送按钮推理态切「终止」并接 `handleTerminateRun`，textarea 维持可输入。

**Requirements**：R1, R2, R3, R4, R8

**Dependencies**：U2

**Files**：
- `src/app/App.tsx`（删 `{isAgentRunning && <AgentRunStatusBar .../>}`；给 ChatPane 传 `agentRunPhase`/`agentRunElapsedSeconds`/`onTerminate`）
- `src/app/components/chat-pane/index.tsx`（输入框区渲染状态行；发送/终止按钮切换）
- `src/app/App.css`（状态行 + 终止按钮样式）

**Approach**：
- App.tsx 删顶部 banner 渲染块（现 line ~400）。`AgentRunStatusBar` 组件可保留并被 ChatPane 复用，或将其文案逻辑（`getAgentRunStatusMessage` + 秒数）内联到输入框区——实现时择简。
- ChatPane 新增 props：`agentRunPhase`、`agentRunElapsedSeconds`、`onTerminate`。
- **状态行 DOM 位置（doc-review 锁定）**：放在 `.composer-box`（现 line ~190）**顶部、textarea 之前**，仅 `isAgentRunning` 时渲染一行 `{phase 文案} · 已运行 {N} 秒`。与既有 `.stage-confirmation` 卡片（现 line ~161，在 `.composer` 内、`.composer-box` 之上）并存时：stage-confirmation 卡片仍在原位（最上），状态行在 `.composer-box` 内，互不堆叠。
- **按钮（doc-review 锁定视觉规格）**：`isAgentRunning ? 终止按钮 : 发送按钮`。终止按钮推理态**可点**（非 disabled）、`onClick={onTerminate}`、背景用 `--error`（`#ff4d4f`，App.css 已有 token）、图标用一个**方块 Stop 内联 SVG，尺寸 18×18 与 `TelegramSendIcon` 一致**；`focus-visible` outline 改浅色（白/`--text-primary`），避免橙色全局 outline 撞红底（design fyi）。发送按钮维持现逻辑（`disabled={!input.trim()}`）。
- textarea：维持现状（推理中不 disabled、Enter 在 `isAgentRunning` 时仍 no-op——Enter 不触发终止，避免误停）。确认按钮（`onConfirm`）维持 `disabled={isAgentRunning}` 不变。

**Patterns to follow**：现 `AgentRunStatusBar`（`chat-pane/index.tsx`）文案与 `agent-run-status` 样式；现发送按钮 markup 与 `TelegramSendIcon` 内联 SVG 写法；CSS 既有 `.agent-run-status`、`--error`/`--error-dim` token。

**Test scenarios**（`src/app/components/chat-pane/chat-pane.test.tsx`）：
- 推理态按钮切换：`isAgentRunning=true` → 渲染「终止」按钮且可点（非 disabled）；点击触发 `onTerminate`。
- 非推理态：`isAgentRunning=false` → 渲染发送按钮，空输入时 disabled、有输入时可点触发 `onSubmit`。
- 状态行：`isAgentRunning=true` 时显示 phase 文案 + 「已运行 N 秒」；`false` 时不渲染状态行。
- stage-confirmation 并存：`isAgentRunning=true` 且 `waiting_confirmation` 同时成立 → stage-confirmation 卡片仍渲染（含灰显「确认并继续」）、状态行 + 终止按钮在 composer-box 内，两者都在、不互相吞渲染。
- textarea 可输入：`isAgentRunning=true` 时 textarea 非 disabled，可 onChange。
- 顶部 banner 移除（`src/app/App.test.tsx`）：`isAgentRunning=true` 时 app 顶部不再渲染原 `AgentRunStatusBar`（按其文案/role 断言不存在于 header 区）。

**Verification**：`vitest run` 全绿；真机推理态下顶部无 banner、输入框区有状态行 + 秒数、按钮为红底「终止」方块图标、textarea 可打字。

---

### U4. 终止全链路集成测试 + e2e 边界 + 真机验收清单

**Goal**：给「点终止 → 杀进程 → 保留内容标注已终止」全链路一个可自动化的集成测试，明确 e2e 能覆盖到哪、真机验收哪些。

**Requirements**：R5, R6, R9

**Dependencies**：U1, U2, U3

**Files**：
- `src/app/App.test.tsx`（集成级：跨 onChunk → 终止 → 塑形 → 落库，见 U2 已含核心场景，本单元补「完整一轮」串联断言）
- `e2e/specs/smoke.spec.ts`（仅补 UI 可达性边界：见下说明）

**Approach**：
- **自动化集成测试**：本技术栈下「e2e 级」的可自动化终点是 vitest 在 App/adapter 接缝上 mock Tauri `invoke` 串起完整终止路径（onChunk 产出 → handleTerminateRun → cancel invoke → reject → terminated 塑形 → repository.save → finishRun 收尾）。这是 U2 场景的串联强化，断言一轮终止后状态机干净、消息持久化、运行态归位。
- **Playwright e2e 的边界（如实记录）**：`e2e/specs/smoke.spec.ts` 跑的是 web 模式且 **fail-closed**（无真 agent，提交即出桌面版 CTA），无法保持「运行中」状态，**不能**驱动真实 worker 杀进程。Tauri 真机用系统 WebKit、无 CDP/tauri-driver，WKWebView 无法自动化（项目既有约束）。故真实杀进程行为**不做** Playwright 覆盖，靠真机验收——与项目既有「真机验收」实践一致。smoke spec 不强加运行态断言。
- **真机验收清单**（boss 手动）：
  1. 发起一轮真实推理 → 顶部无 banner、输入框区显示状态 + 秒数、按钮为红底「终止」、textarea 可打字。
  2. 推理中途点「终止」→ 输出立即停止、已产出部分保留 + 末尾「已终止」、事件流无「执行失败」、运行态收尾、可立即发起下一轮（单例锁释放）。
  3. 终止后 worker 进程及其 MCP child 确实退出（`ps` 无残留、sidecar token 不被孤儿持有）。
  4. 终止后刷新/重开会话，「已终止」消息仍在（持久化）。
  5. 刚提交、worker 尚未起来就点「终止」（`killed:false` 早窗）→ 不误标「已终止」、给轻提示、本轮正常完成或失败照常显示。

**Test scenarios**：
- 集成串联（vitest）：一轮提交 → 产出两个 chunk → 终止 → 断言（a）`cancel_claude_agent` 以正确 runId 调用一次（b）最终消息 = 已产出 + 已终止（c）`repository.save` 持久化（d）`isAgentRunning` 回 false、refs 归位。
- e2e 边界（playwright，可选最小补充）：web 模式提交后出桌面版 CTA 的现有断言保持通过即可（确认本改动未破坏 web fail-closed 边界）。不新增运行态终止断言。

**Verification**：`vitest run` + `cargo test` 全绿；`playwright test` smoke 仍通过；真机验收清单 4 项逐条过。

---

## 范围边界

**做**：ideation 点子 #8 的五条（撤顶部 banner / 状态下沉 / textarea 可输入 / 发送切终止 / 真终止），加终止后内容保留标注 + 持久化。

**不做（Deferred to Follow-Up Work）**：
- 「终止中…」按钮过渡态 / 二次确认弹窗（本期点击即终止，最简）。
- SIGTERM 优雅退出（worker 无清理逻辑，KTD/R7 定为直接 SIGKILL）。
- redo / 撤销已终止 / 重新发起上一条（不在 #8 范围）。
- planner 任务 stop（不同子系统，独立契约）。
- 真机 WKWebView 的自动化 e2e（引擎限制，靠真机验收）。
- Windows pid 复用的强硬化（CreateJobObject 替裸 pid）——本期靠「去注册紧贴 reap」收紧窗口 + 注释标注，完整硬化 defer。
- 终止后自动跑 topology.validate 暴露「已 commit 未回传」的变更——本期仅文案不虚假承诺，自动核对 defer。

---

## 风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| 终止按钮在 worker 注册前/run 已收尾时被点 | 把没杀到的 run 误标「已终止」 | cancel 返回 `killed:bool`，前端仅 `killed:true` 才标终止（KTD1/KTD3）；`killed:false` 给轻提示 |
| 真崩溃与点击同一瞬 | 把崩溃误标「已终止」、丢诊断 | 同上：`killed` 闸门——崩溃时 registry 已清→`killed:false`→走失败路径 |
| reap 后 pgid/pid 复用 | 误杀第三方进程组 | 去注册紧贴 reap（同锁 take）；Unix 杀前 `kill(-pgid,0)` 探活；Windows pid 复用硬化 defer（见范围） |
| SIGKILL 中途打断 apply_operations | 半应用脏拓扑 | `apply_operations` 单事务，未 commit 即回滚、无损坏；已 commit 未回传的有效变更下次快照可见（非损坏，文案不声称原状） |
| late chunk 覆盖「已终止」消息 | 消息被在途 chunk 冲掉 | 塑形前置 `settled`，onChunk 收尾后丢弃（U2） |
| 杀进程后 reader 线程读断裂 pipe | 线程报错 | 现有 `drain_*` 容错框架已处理（与超时强杀同路径） |
| 僵尸进程 | 进程残留 | 由既有阻塞循环 `try_wait()/wait()` 收割（KTD2），cancel 不双重 own |
| async 闭包读 state 过期 | 终止分支误判 | cancel 状态走 `useRef` 而非 state（KTD3） |
| CI clippy/rustfmt 1.96 版本错位 | CI 红 | 本地 `cargo +1.96.0 fmt/clippy` 自检后再推（项目既有踩坑） |

**依赖**：复用现有进程组强杀逻辑（`commands.rs` 超时分支 + 单测）；runId 全链贯通；单例锁 `ClaudeAgentRunGuard`。无新增外部依赖。

---

## 系统级影响

- 新增一个 Tauri 命令 `cancel_claude_agent` + 一个 managed state，纯加法、不改现有 `run_claude_agent` 数据流。
- 顶部 banner 移除是唯一的「移除」，且是按 R1 把它挪进输入框区（功能不丢）。
- 终止路径与超时强杀共用同一 kill helper，收敛而非新增双轨。
