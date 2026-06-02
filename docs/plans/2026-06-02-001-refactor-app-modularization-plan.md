---
date: 2026-06-02
plan-id: 2026-06-02-001
type: refactor
topic: app-modularization
source-brainstorm: docs/brainstorms/2026-06-02-app-modularization-requirements.md
branch: refactor/app-modularization-2026-06-02
---

# App 模块化重构 + 模块边界修正 + E2E 补全 实施计划

## 目标摘要

把 `src/app/App.tsx`（2400 行）切分为 hooks + 组件文件，修正 3 个模块边界（domain→topology 反向依赖、project→workflow 重命名、session-topology-repair 挪位），新增 6 条 Playwright spec 覆盖关键路径。每个新文件 ≤300 行，所有现有测试保持通过。

## 范围引用

详见 `docs/brainstorms/2026-06-02-app-modularization-requirements.md` 的"范围边界"。本计划严格遵守该边界，不扩张到 worker / adapter / Rust commands 拆分。

## Scope Boundaries

显式不做（防止范围爆炸）：

- 不拆 `src-node/claude-agent-worker.mjs`
- 不拆 `src/agent/agent-adapter.ts`
- 不拆 `src-tauri/src/commands.rs`
- 不引入 zustand / Redux / 任何状态管理库
- 不改任何业务逻辑、UI 视觉、persistence schema、错误恢复策略
- 不动 `src/domain/canonical.ts`、`scenario-config.ts` 类型定义
- 不动 `src/agent/agent-adapter.ts` 内部（仅允许改 import 路径）

## 关键设计决策（已决定）

以下决策在 plan 评审后确定，实施时不再讨论：

### D1 — 跨 hook 状态归属

| 状态 | 归属 | 跨边界方式 |
|---|---|---|
| `sessions` / `currentSession` / `isHydrating` | `useSessionRepository` | hook 返回 |
| `persistSession` 函数 | `useSessionRepository` | hook 返回，`useAgentRunController` 入参接收 |
| `isAgentRunning` / `agentRunPhase` / `agentRunStartedAt` / `agentRunElapsedSeconds` / `lastAgentChunkAt` | `useAgentRunController` | hook 返回 |
| `pendingAssistantMessageId` | `useAgentRunController` | hook 返回，`ChatPane` 通过 prop 接收 |
| `plannerBaseUrl` / `isPlannerActionRunning` | `usePlannerRun` | hook 返回 |
| `exportDirectory` / `exportResult` / `exportError` | `useProjectExport` | hook 返回 |
| `diagnosticsRepository` | module-scope 单例（保持现状） | 直接 import，不入参 |
| `selectedTopologyItem` / `selectedFlowId` / `activeConfigTab` | App.tsx | useState 留在顶层，传 props 给 WorkspacePane |

### D2 — 不引入 React Context

`diagnosticsRepository` 保留为 module-scope 单例，所有 hook 直接 `import { diagnosticsRepository }`。理由：当前所有消费者只读不写、单实例够用，引入 Context 增加测试复杂度无收益。

### D3 — Hook 内部状态管理

每个 hook 默认用 `useState` 集合；只有 `usePlannerRun` 的 transient retry 计数 + status 转移涉及 ≥3 个相关字段，可用 `useReducer`，由实施时决定。

### D4 — E2E 拦截策略：显式 test-only runtime swap

在 `src/main.tsx` 添加：

```typescript
// 仅 Playwright 测试模式：window.__TSN_TEST_RUNTIME__ 注入后启用
if (import.meta.env.MODE === "development" && (window as any).__TSN_TEST_RUNTIME__) {
  await import("./test/playwright-runtime-bridge").then(m => m.installTestRuntime());
}
```

`src/test/playwright-runtime-bridge.ts` 通过 monkey-patch `runTsnAgent` 让其调用 `dispatchAgentStage`。**production build (`import.meta.env.MODE === "production"`) 永远不会触发此分支**——production 模式 Vite 会做 dead code elimination 直接删掉这段。

每个 spec 用 `page.addInitScript(() => { (window as any).__TSN_TEST_RUNTIME__ = true; })` 启用。

### D5 — `src/project/` → `src/workflow/` 重命名范围

本次只改 directory 名 + import 路径；内部文件名（`project-state.ts` 等）和 `ProjectState` type 保持不变。`ProjectState` → `WorkflowSessionView` type rename 推到后续 PR（独立、机械、风险低）。

### D6 — App.tsx 行数硬限制改为 ≤400

`≤300` 是 brainstorm 时的 aspirational 数字；实际 App.tsx 收尾后必留的内容（imports + 顶层 layout JSX + hook composition + prop 派生 + 6 个保留的 useState）落地估计 350-400 行。`≤400` 是 realistic budget。其他抽出的 hook/component 文件仍维持 ≤300 行（一个 hook 或一个组件的合理上限）。

### D7 — U8 → U9 串行执行

U8 和 U9 都改 import 路径（U8 在 `topology-factory` / `session-topology-repair`，U9 在 `project/`），并行会互相覆盖 sed 替换结果。改为 `U8 → U9` 串行，独立 commit。

### D8 — Hooks / components 目录约定

新建 `src/app/hooks/` 和 `src/app/components/<group>/` 是有意识的引入。理由：(1) 沿用 React 社区主流约定，(2) 与现有 `src/ui/diagnostics/` 和 `src/ui/skills/` 的"按 feature 分子目录"形态一致，(3) App.tsx 之外未来若有第二个顶层 page 也可共享。

## Requirements Trace

仅列功能性产出。post-implementation 校验（vitest/tsc/Playwright/grep）见下方 Verification Criteria。

| 需求 | 实施单元 |
|---|---|
| App.tsx ≤300 行 | U1-U7（hook + 组件抽取） + U11 收尾 |
| 每个新文件 ≤300 行 | U1-U7 each |
| 消除 domain→topology 反向依赖 | U8 |
| `project/` 改名 `workflow/` | U9 |
| `session-topology-repair` 挪位 | U8 |
| 6 条新 E2E spec | U10 |
| import path 替换完成 | U11 |

## Verification Criteria

所有 unit 完成后必须满足：

- `npm test` → 全部通过
- `./node_modules/.bin/tsc --noEmit` → 0 错误
- `npm run cargo:test` → 全部通过
- `npm run e2e:ui-smoke` → 全部通过
- `find src/app -name "*.tsx" -o -name "*.ts" | grep -v test | xargs wc -l | awk '$1 > 300'` → 输出为空
- `grep -r "from.*src/project" src/` → 输出为空
- `grep -r "from.*domain/topology-factory" src/ src-node/` → 输出为空

---

## Implementation Units

### U0：基线测量 + 残值估算

**Goal**：建立可量化的执行 baseline，避免最后一刻发现 App.tsx 收尾超 400 行。

**Files**：
- 新建 `docs/plans/2026-06-02-001-baseline.md`（实施期辅助文档，merge 前删除）

**Approach**：
1. `npx vitest run src/app/App.test.tsx --reporter=verbose | tee baseline-app-tests.txt`，记录 test 名清单 + pass 总数
2. 在 App.tsx 上做"纸上抽离"：标记每个待抽 hook / 组件的行号区间，估算残值（imports + 顶层 layout JSX + hook composition + useState 保留项）
3. 估算 ≤400 → 通过；估算 >400 → 在 baseline.md 里列出额外需抽的内容，可能新增 `useTopologyDerivations` hook

**Verification**：
- `baseline-app-tests.txt` 存在
- baseline.md 含三段：测试基线、残值估算、决策

**Execution note**：mechanical。本 unit 无代码改动。

---

### U1：抽 `useSessionRepository` hook

**Goal**：把 sessions list / currentSession / hydration / new / select / duplicate / delete 全部封装到 hook，App.tsx 通过 `const { sessions, currentSession, ... } = useSessionRepository()` 一行获取。

**Files**：
- 新建 `src/app/hooks/use-session-repository.ts` (~180 行)
- 新建 `src/app/hooks/use-session-repository.test.ts` (~150 行)
- 改 `src/app/App.tsx`：删 sessions/currentSession state + hydration effect + handleNewSession/handleSelectSession/handleDuplicateSession/handleDeleteSession + persistSession 工厂函数 → 替换为 hook 调用

**Approach**：
- hook 内部保留 `repository`（module-scope 或 useRef 单例）+ `diagnosticsRepository` 依赖；hook 入参可选 `{ repositoryFactory }` 用于测试注入。
- 返回类型：`{ sessions, currentSession, isHydrating, persistSession, ...handlers }`。
- 测试用 `BrowserDiagnosticLogRepository` + memory storage 即可，不需要 Tauri。

**Execution note**：characterization-first。抽 hook 前用 `npx vitest run src/app/App.test.tsx --reporter=verbose` 记录当前基线（pass 数 + test 名清单）；hook 抽出后必须保持同一组 test 名全绿，pass 数 ≥ 基线值。

**Patterns to follow**：
- 参考 `src/agent/agent-adapter.ts` 的 fail-closed + diagnostics 注入模式
- hook 内部 effect 模式参考 `App.tsx:143-168` 现有 hydration effect 写法

**Test scenarios**：
- happy path：hook 初始化后从 repository 恢复 list，currentSession 是最新一条
- 空仓库：hydration 完成后自动新建一条会话
- new session：handleNewSession 后 sessions list 增加一条，currentSession 切到新会话
- delete session：删 current 后 currentSession 切到 next 一条；删完全部触发新建空 session
- persistSession：返回函数接收 session 写回 repository

**Verification**：
- `npx vitest run src/app/hooks/use-session-repository.test.ts` 全绿
- `npx vitest run src/app/App.test.tsx` 全绿
- `wc -l src/app/hooks/use-session-repository.ts` ≤300
- App.tsx 减少 ~180 行

---

### U2：抽 `useAgentRunController` hook

**Goal**：封装 agent 调用主流程 + 状态机（isAgentRunning / phase / chunk / step / stall / elapsed）。

**Files**：
- 新建 `src/app/hooks/use-agent-run-controller.ts` (~280 行)
- 新建 `src/app/hooks/use-agent-run-controller.test.ts` (~200 行)
- 改 `src/app/App.tsx`：删 isAgentRunning/agentRunPhase/agentRunStartedAt/agentRunElapsedSeconds/lastAgentChunkAt/pendingAssistantMessageId state + 3 effect（stall/elapsed/scroll）+ submitIntent 主函数 → 替换为 hook

**Approach**：
- hook 入参 `{ currentSession, persistSession }`（diagnosticsRepository 通过 module import），返回 `{ isAgentRunning, agentRunPhase, agentRunElapsedSeconds, pendingAssistantMessageId, submitIntent, scrollContainerRef }`。
- submitIntent 内部仍调用 `runTsnAgent`（不改 adapter）；hook 负责所有 UI 状态副作用。
- 滚动 ref 通过 hook 返回，App.tsx 把它绑到 messages 容器。
- `pendingAssistantMessageId` 是 hook owned state（D1），ChatPane 通过 prop 接收。

**Forward-compatible contract**：本 hook 与 agent 层（runTsnAgent）的契约：
- 输入：`{ userIntent, session, runId, diagnostics, onChunk, onAgentStep }`（保持现有 TsnAgentRequest 形态）
- 输出：`TsnAgentResult` 三态 union 不变
- 副作用通道：onChunk / onAgentStep 回调（不改）

未来 adapter 拆分（独立 PR）只要保持此契约不变，本 hook 不需要重构。

**Execution note**：characterization-first。抽 hook 前用 `npx vitest run src/app/App.test.tsx --reporter=verbose` 记录基线（pass 数 + test 名）；重点关注涉及 agent 调用的测试（"applies valid topology" / "rejects stage result" / 步骤摘要相关）。hook 抽出后这些测试必须按名全绿。

**Patterns to follow**：
- `src/agent/agent-adapter.ts:runTsnAgent` 的入参/出参接口
- App.tsx 现有 `submitIntent`（line 419-608）的事件顺序

**Test scenarios**：
- submitIntent 期间 isAgentRunning = true，结束置 false
- stall：3s 内无 chunk 切到 waiting phase
- success：result.shouldApplyProject=true 时 persistSession 被调用一次，含新 project / workflow / events
- failure-preserved：result.shouldApplyProject=false 时 persistSession 不写 project
- runtime-unavailable：result.kind=runtime-unavailable 时 assistantText 含 CTA
- 重复触发：isAgentRunning=true 时 submitIntent 直接返回不再起任务

**Verification**：
- `npx vitest run src/app/hooks/use-agent-run-controller.test.ts` 全绿
- `npx vitest run src/app/App.test.tsx` 全绿
- `wc -l src/app/hooks/use-agent-run-controller.ts` ≤300
- App.tsx 减少 ~300 行

---

### U3：抽 `usePlannerRun` hook

**Goal**：封装 planner baseUrl / start / stop / poll / attach / fingerprint 全套逻辑。

**Files**：
- 新建 `src/app/hooks/use-planner-run.ts` (~280 行，含 module-local helpers)
- 新建 `src/app/hooks/use-planner-run.test.ts` (~180 行)
- 改 `src/app/App.tsx`：删 plannerBaseUrl / isPlannerActionRunning state + 2 ref + 同步/调度 effect + start/stop/poll/attach + 所有 planner 纯函数

**Approach**：
- 纯函数（`plannerRunFromStartResponse` / `plannerRunFromQueryResponse` / `isExpectedPlannerRun` / `isLatestPlannerRun` / `assertSuccessfulPlannerResult` / `normalizePlannerState` / `createPlannerRunToken` / `plannerRunForAgentResult`）作为 **module-local 非 export 函数**放在 `use-planner-run.ts` 顶部，通过 hook 测试间接覆盖。理由：只有 hook 一个消费者，单独抽到 utils/ 增加 4 个文件无收益（scope-guardian 评审决议）。
- hook 内部用 useRef 维持 timeout id + retry count；返回 `{ plannerBaseUrl, setPlannerBaseUrl, isPlannerActionRunning, handleStart, handleStop, plannerResultForCurrentProject }`

**Execution note**：pragmatic。planner 测试覆盖原本就少，hook 抽出后允许新增基础测试，但不强求覆盖率提升。

**Patterns to follow**：
- `src/planner/planner-contract.ts` 的 PlannerRun 类型与转换
- App.tsx 现有 polling 的 timeout / retry 模式

**Test scenarios**：
- handleStart 成功 → plannerRun.status = running
- poll 返回 succeeded → 调用 attachPlannerResult
- 连续网络错误：第 1、2 次保留 running（按当前 `PLANNER_TRANSIENT_FAILURE_RETRY_LIMIT = 2` 容忍），第 3 次失败时 plannerRun.status = failed
- handleStop 成功 → plannerRun.status = idle
- unmount 时 timeout 被清理（hook 的 cleanup）

**Verification**：
- `npx vitest run src/app/hooks/use-planner-run.test.ts` 全绿
- `npx vitest run src/app/App.test.tsx` 全绿
- `wc -l src/app/hooks/use-planner-run.ts` ≤300

---

### U4：抽 `useProjectExport` hook

**Goal**：封装 exportDirectory / refreshBundle / handleExportProject / 建议目录 effect。

**Files**：
- 新建 `src/app/hooks/use-project-export.ts` (~140 行)
- 新建 `src/app/hooks/use-project-export.test.ts` (~120 行)
- 改 `src/app/App.tsx`：删 exportDirectory / exportResult / exportError state + 建议目录 effect + 3 个 export handler + refreshBundle + bundleForAgentResult（移到 utils）

**Approach**：
- `bundleForAgentResult` 改成 helper 移到 `src/app/utils/bundle-helpers.ts`
- hook 入参 `{ currentSession, persistSession, diagnosticsRepository }`，返回 `{ exportDirectory, setExportDirectory, exportResult, exportError, canExport, canRefreshBundle, refreshBundle, handleExportProject, handleChooseExportDirectory, handleOpenExportDirectory }`

**Execution note**：pragmatic。

**Patterns to follow**：`src/export/artifact-bundle.ts` 的 ArtifactBundle 接口

**Test scenarios**：
- workflow 在 planning-export waiting/confirmed → canExport=true
- refreshBundle 重新生成 bundle 并 persistSession
- handleExportProject 调用 exportProjectBundle 成功后写 exportResult
- 建议目录 effect：currentSession.id 变化时清空 exportResult 并调 invoke 拿建议路径

**Verification**：
- `npx vitest run src/app/hooks/use-project-export.test.ts` 全绿
- `npx vitest run src/app/App.test.tsx` 全绿
- `wc -l src/app/hooks/use-project-export.ts` ≤300

---

### U5：抽出 WorkspaceTools 一组组件（左侧抽屉）

**Goal**：`WorkspaceToolRail` / `WorkspaceToolDrawer` / `SessionToolPanel` / `SkillToolPanel` / `SettingsToolPanel` / `ReleaseNoteDetail` 及关联文案函数搬到 `src/app/components/workspace-tools/`。

**Files**：
- 新建 `src/app/components/workspace-tools/WorkspaceToolRail.tsx`
- 新建 `src/app/components/workspace-tools/WorkspaceToolDrawer.tsx`
- 新建 `src/app/components/workspace-tools/SessionToolPanel.tsx`
- 新建 `src/app/components/workspace-tools/SkillToolPanel.tsx`
- 新建 `src/app/components/workspace-tools/SettingsToolPanel.tsx`
- 新建 `src/app/components/workspace-tools/ReleaseNoteDetail.tsx`
- 新建 `src/app/components/workspace-tools/labels.ts`：`workspacePanelLabel/Kicker/Subtitle` + `skillStatusLabel`
- 改 `src/app/App.tsx`：删对应函数定义，import 新组件

**Approach**：
- 每个组件接收 props 而非通过 context，保持显式数据流
- `SessionToolPanel` 接 sessions / currentSession / onNew / onSelect / onDuplicate / onDelete 全部从 hook 传入

**Execution note**：pragmatic。这些组件已经是闭包友好（不依赖 App.tsx 局部 state），抽出风险低。

**Patterns to follow**：`src/ui/skills/SkillFilePreview.tsx` 的纯组件 + 测试模式

**Test scenarios**：
- 每个组件至少 1 个 smoke test（render with minimal props 不抛错）
- SessionToolPanel：click new → onNew 被调用一次
- SettingsToolPanel：选不同版本切换 ReleaseNoteDetail 内容

**Verification**：
- `npx vitest run src/app/components/workspace-tools/` 全绿
- `npx vitest run src/app/App.test.tsx` 全绿
- 每个 .tsx ≤300 行

---

### U6：抽出 ChatPane 组件 + AgentStepStream 组件

**Goal**：把"中间会话区"和"步骤摘要展开"两组抽成独立组件。

**Files**：
- 新建 `src/app/components/chat-pane/ChatPane.tsx`：project-strip + stepper + messages list + composer
- 新建 `src/app/components/chat-pane/Step.tsx`：stepper 单格
- 新建 `src/app/components/chat-pane/AgentWaitingIndicator.tsx`
- 新建 `src/app/components/chat-pane/LegacyOriginBanner.tsx`
- 新建 `src/app/components/agent-step-stream/AgentStepStream.tsx`：AgentStepSummaryGroup + AgentStepDetailView + deriveStepCardState + stepCardStateLabel + StepCardState 类型 + stampAgentEvents
- 新建 `src/app/components/agent-step-stream/AgentStepStream.test.tsx`
- 新建 `src/app/components/AgentRunStatusBar.tsx` + 同目录 `agent-run-status.ts`（getAgentRunStatusMessage）
- 改 `src/app/App.tsx`：删对应函数和 JSX 段

**Approach**：
- AgentStepStream 是 ChatPane 的子组件，通过 props 接 runId + events + stepDetails + expandedTraceId + onToggleExpanded
- ChatPane 通过 props 接 currentSession + workflow + handlers，不直接读 hook

**Execution note**：pragmatic。`AgentStepSummaryGroup` 已在 App.tsx 内部存在，搬出后保留同样的渲染契约，原有针对它的端到端断言（在 App.test.tsx 多处）继续作为回归网。

**Patterns to follow**：当前 `App.tsx:2250-2302` 的 `AgentStepSummaryGroup` 实现 + 现有 App.test.tsx 中"步骤摘要"相关断言

**Test scenarios**：
- AgentStepStream：渲染含 runId 的 events 列表
- click step button → onToggleExpanded 被调用 + expandedTraceId 切换
- 无 detail 时显示"该步骤没有保存更多详情"
- aborted/error 状态 → 对应 className
- ChatPane：render with 1 user + 1 assistant message → 文本可见

**Verification**：
- 新增组件单测全绿
- App.test.tsx 全绿
- 每文件 ≤300 行
- App.tsx 减少 ~300 行

---

### U7：抽出 WorkspacePane 一组组件（右侧工作区）

**Goal**：拓扑画布 + 4 个 config tab panel 全部抽到 `src/app/components/workspace-pane/`。

**Files**：
- 新建 `src/app/components/workspace-pane/WorkspacePane.tsx`：tab 容器（最薄）
- 新建 `src/app/components/workspace-pane/TopologyStage.tsx`：ReactFlow 画布 + TsnTopologyNode
- 新建 `src/app/components/workspace-pane/ConfigTabs.tsx`：tab 切换逻辑
- 新建 `src/app/components/workspace-pane/FlowsPanel.tsx`
- 新建 `src/app/components/workspace-pane/NodeDetailPanel.tsx` + `findPortIndex`
- 新建 `src/app/components/workspace-pane/LinkDetailPanel.tsx`
- 新建 `src/app/components/workspace-pane/ArtifactsPanel.tsx` + `groupArtifacts` + `artifactGroupFallbackLabels`
- 新建 `src/app/components/workspace-pane/PlannerTaskPanel.tsx` + `plannerStatusLabel`（搬过来）
- 新建 `src/app/components/Stat.tsx`、`DetailRow.tsx`（共享小工具，移到 components/）
- 改 `src/app/App.tsx`：删对应 JSX 段 + Stat/DetailRow/TsnTopologyNode/PlannerTaskPanel/findPortIndex/groupArtifacts/artifactGroupFallbackLabels

**Approach**：
- 每个 Panel 通过 props 接 ProjectState 切片 + handler
- TopologyStage 接受 flowTopology（在 App.tsx 用 useMemo 算好后传入）

**Execution note**：pragmatic。

**Patterns to follow**：现有 ReactFlow 使用方式（不改 ReactFlow 集成方式）

**Test scenarios**：
- TopologyStage：render 4-switch project，看到 SW-1..SW-4 + ES-1-1..ES-4-1
- FlowsPanel：render flows 列表 + click 流 → onFlowSelect
- ArtifactsPanel：bundle.artifacts 分组 + 文件名可点
- PlannerTaskPanel：plannerRun.status=running 时显示 Stop 按钮

**Verification**：
- 新增组件单测全绿
- App.test.tsx 全绿
- 每文件 ≤300 行
- App.tsx 减少 ~400 行，预期总体 ≤300 行

---

### U8：移动 `domain/topology-factory.ts` + `sessions/session-topology-repair.ts` 到 `topology/`

**Goal**：消除 domain→topology 反向依赖，sessions 目录只剩持久化关注点。

**Files**：
- 移动 `src/domain/topology-factory.ts` → `src/topology/topology-factory.ts`
- 移动 `src/domain/topology-factory.test.ts` → `src/topology/topology-factory.test.ts`
- 移动 `src/sessions/session-topology-repair.ts` → `src/topology/project-from-messages.ts`（同时改名）
- 移动 `src/sessions/session-topology-repair.test.ts` → `src/topology/project-from-messages.test.ts`
- 全仓 `from "../domain/topology-factory"` → `from "../topology/topology-factory"`
- 全仓 `from "../sessions/session-topology-repair"` → `from "../topology/project-from-messages"`
- 全仓 import path 用 sed 批量替换 + tsc 验证

**Approach**：
- 单 commit 完成（移动 + import 替换 + tsc clean）
- 不动文件内部逻辑

**Execution note**：mechanical。无需 TDD，纯文件移动。

**Patterns to follow**：N/A

**Test scenarios**：依赖现有测试套件不变即可。

**Verification**：
- `npm test` 全绿
- `./node_modules/.bin/tsc --noEmit` clean
- `grep -r "domain/topology-factory" src/ src-node/` 输出为空
- `grep -r "session-topology-repair" src/ src-node/` 输出为空

---

### U9：重命名 `src/project/` → `src/workflow/`

**Goal**：消除 `project` 一词在"数据快照（CanonicalTsnProject）"和"workflow 状态机"之间的二义。

**Files**：
- `git mv src/project src/workflow`
- 内部文件保留原名（project-state.ts 仍叫这个，避免改动面再扩大）
- 全仓 `from ".../project/"` → `from ".../workflow/"`
- App.tsx import 路径同步更新

**Approach**：
- 单 commit。如果 import 影响超过 30 处，分两步：先建 `src/project/index.ts` re-export 兼容层 + 全仓改 → 跑 tsc → 删 re-export

**Execution note**：mechanical。

**Patterns to follow**：N/A

**Test scenarios**：依赖现有测试套件不变即可。

**Verification**：
- `npm test` 全绿
- `./node_modules/.bin/tsc --noEmit` clean
- `find src/project 2>&1` → No such file
- `grep -rEn "from\s+['\"][^'\"]*/project/[a-z-]+['\"]" src/ src-node/` → 输出为空（精确匹配目录前缀 `/project/`，不会误命中 `project-bridge` 等文件名）

---

### U10：补 6 条 Playwright E2E spec（含 test-only runtime swap 接入）

**Goal**：覆盖会话切换、拓扑编辑、错误恢复、runtime-unavailable CTA、planner 任务、diagnostics 抽屉。

**Files**：
- 改 `src/main.tsx`：加 dev-only `__TSN_TEST_RUNTIME__` 接入点（按 D4 决策）
- 新建 `src/test/playwright-runtime-bridge.ts` (~80 行)：monkey-patch `runTsnAgent` 走 `dispatchAgentStage`
- 新建 `src/test/playwright-runtime-bridge.test.ts` (~60 行)：确认 production build 下不会触发安装
- 新建 `e2e/specs/session-switching.spec.ts`
- 新建 `e2e/specs/topology-editing.spec.ts`
- 新建 `e2e/specs/runtime-unavailable.spec.ts`
- 新建 `e2e/specs/diagnostics-drawer.spec.ts`
- 新建 `e2e/specs/planner-flow.spec.ts`
- 新建 `e2e/specs/error-recovery.spec.ts`
- 新建 `e2e/fixtures/test-runtime.ts`：共享 `page.addInitScript` 启用代码

**Approach**：
- D4 决策的 test-only runtime swap：`main.tsx` 在 `import.meta.env.MODE === "development"` AND `window.__TSN_TEST_RUNTIME__` 同时为真时，动态 import `playwright-runtime-bridge` 并 install。production build 下 `import.meta.env.MODE === "production"` 是编译时常量，Vite tree-shake 自动删除整段，**production bundle 不含 dispatcher 任何字节**
- `playwright-runtime-bridge.installTestRuntime()`：用 Proxy / module mock 让后续 `runTsnAgent` 调用 `dispatchAgentStage`（同样的 fixture builder 产出，UI 行为与单测一致）
- 每个 spec 的 `test.beforeEach`：`await page.addInitScript(() => { (window as any).__TSN_TEST_RUNTIME__ = true; })`
- `runtime-unavailable.spec.ts` 不启用 bridge（保持 fail-closed 路径），其它 5 个启用

**Execution note**：pragmatic。U10 是本次 plan 中最高不确定性项；先实施 `playwright-runtime-bridge` + 单条 `session-switching.spec.ts` 验证端到端可行，再展开其余 5 条。
**production safety verification**：U10 完成后必须验证 `npm run build && grep -l "playwright-runtime-bridge\|dispatchAgentStage" dist/` 输出为空。

**Patterns to follow**：现有 `e2e/specs/ui-smoke.spec.ts` 的语法

**Test scenarios**：见 brainstorm 表格

**Verification**：
- `npm run e2e:ui-smoke` → 7 条全绿
- 每个 spec 文件 ≤80 行

---

### U11：App.tsx 收尾 + import 全仓梳理

**Goal**：把剩余的 App.tsx 精简到 ≤400 行（按 D6），组合所有 hook + 顶层布局，统一所有 import 路径。

**Files**：
- 改 `src/app/App.tsx`：仅保留顶层 hook 组合 + 顶层布局 + 极少量未拆出的辅助
- 改 `src/app/App.test.tsx`：相关 import 路径同步
- 全仓 import 路径检查 + 重排

**Approach**：
- 此 unit 之前所有 hook / 组件都已抽出，本 unit 只做"收尾"
- App.tsx 最终结构：
  ```
  imports
  const App = () => {
    const session = useSessionRepository()
    const agentRun = useAgentRunController(session)
    const planner = usePlannerRun(session)
    const export_ = useProjectExport(session)
    return <Layout>...</Layout>
  }
  export default App
  ```

**Execution note**：pragmatic。

**Verification**：
- `wc -l src/app/App.tsx` ≤400
- `npm test` 全绿
- `./node_modules/.bin/tsc --noEmit` clean
- `npm run e2e:ui-smoke` 全绿

---

## 执行顺序与依赖

```
U0 ──► U1 ──► U2 ──► U3 ──► U4 ──► U5 ──► U6 ──► U7 ──► U10 ──► U11
                                                          (test-only runtime swap 必须先有)
U8 ──► U9（U8 完成后再启动 U9，避免 sed 替换互相覆盖）
```

- U0 是必需的前置基线（无 U0 不能开始任何抽离）
- U1-U7 串行（每抽一个 hook / 组件就更新 App.tsx 并跑全测，保证基线绿）
- U8 → U9 串行（D7 决策），与 U1-U7 任何阶段都可并行
- U10 必须在 U7 完成后启动（确保抽出的组件已稳定）
- U11 是最后收尾

**U2 完成后检查点**：
- 度量 App.tsx 行数减少量；若 < 400 行减少（target ~480），重审 U3-U7 是否需要追加 `useTopologyDerivations` hook 抽 line 270-372 派生块
- 度量 vitest 全套耗时；若增加 > 20%，分析是否过度引入异步等待，必要时调整 hook 测试策略

## Per-Commit 策略

每个 Implementation Unit 独立 commit。commit message 格式：

```
refactor(app): extract <unit-name> (U<n>)

<one-line rationale>

Tests: <relevant test command result>
```

## 最终交付

- 单一 PR base=main（或 base=feat/agent-runtime-session-experience 等 PR #2 merge 后 rebase）
- title：`refactor(app): modularize App.tsx + correct module boundaries + add E2E coverage`
- body 含 Post-Deploy Monitoring & Validation 段（即使是纯重构也填）

## 风险

| 风险 | 缓解 |
|---|---|
| hook 抽离丢 effect dependency | U0 先建立 vitest verbose baseline；每抽一个 hook 后按 test 名比对；React `<StrictMode>` 帮助暴露 effect 重复触发 |
| `project/` → `workflow/` 改名波及多文件 | 实测 11 处 import，单 commit 完成；tsc 验证 |
| E2E 拦截方案不可行 | D4 决策：显式 test-only runtime swap，production guard 由 `import.meta.env.MODE` 编译时常量保证；U10 先实施 bridge + 单条 spec 验证再展开 |
| `__TSN_TEST_RUNTIME__` flag 在 production 误启用 | `main.tsx` 接入点用 `import.meta.env.MODE === "development"` 编译时常量守护；production build 中 Vite tree-shake 直接删除；U10 verification 含 `grep` 检查 dist/ |
| PR 太大难 review | 每 unit 独立 commit；reviewer 可逐 commit 审；如 rebase 产生 App.tsx 冲突，用 `git rebase -i` + `edit` 逐 commit 重放 hunks 保 atomicity |
| 重构期 conflict 风险 | branch 基于 main（PR #2 此时已 merge 或可独立 rebase）；如 PR #2 仍 open，rebase 到 PR #2 head 后跟随 PR #2 一起 merge |
| App.tsx ≤400 仍超 | U2 完成后做 checkpoint，必要时新增 `useTopologyDerivations` hook 抽 line 270-372 派生块（已在执行顺序段列为兜底方案）|
