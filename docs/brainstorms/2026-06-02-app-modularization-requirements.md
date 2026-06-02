---
date: 2026-06-02
topic: app-modularization
---

# App.tsx 拆分 + 模块边界修正 需求

## 摘要

`src/app/App.tsx` 已增长到 2400 行（18 useState、11 useEffect、22 handler、18 子组件、14 派生函数），是仓库内最大的可重构资产。同时领域目录边界存在反向依赖（`domain/topology-factory.ts` 反向 import `topology/`）和命名歧义（`src/project/` 维护的是 workflow 状态机而非 canonical project），让"在哪个目录改什么"持续给协作和 Agent 上下文造成摩擦。E2E 仅 1 条 spec 覆盖 happy path，重构后无法快速验证关键回归。

本次目标是把这三件事按相互独立、可验证、可回退的边界落地：App.tsx 按职责切成 hook + 组件、领域目录消除反向依赖与歧义、E2E 补齐 5-6 条关键路径。worker / adapter / Rust commands 的同类拆分留作独立 follow-up，避免单 PR 改动面过大。

---

## 问题框架

当前 App.tsx 同时承担 5 个独立的关注点：

1. **会话生命周期**：sessions 列表 / current / hydration / new / select / duplicate / delete
2. **Agent 调用编排**：runId / phase / chunk / step / stall / 元数据写回 / 错误恢复
3. **Planner 任务**：baseUrl / start / stop / 轮询 / 结果挂载 / fingerprint
4. **导出流程**：refreshBundle / chooseDir / handleExportProject / 建议目录
5. **UI 编排**：workspace rail、stepper、chat stream、topology canvas、4 个 config tab

这些关注点彼此基本不耦合（状态依赖 1-2 个共享变量），但都挤在同一个组件函数里，导致：

- **Agent 协作摩擦**：任何改动都要重新理解 2400 行；上下文窗口经常被 App.tsx 吃掉一半
- **测试粒度过粗**：`App.test.tsx` 已经 979 行依赖 stage-dispatcher mock；想测 Planner 必走完整 agent → workflow 链路
- **复用成本高**：任何想复用 AgentRunStatusBar / WorkspaceToolDrawer 的新页面都要复制 App.tsx 状态

领域目录层面：

- `src/domain/topology-factory.ts` import `src/topology/initialize.ts` 和 `src/topology/project-bridge.ts`，造成"domain 依赖 topology"，违反"domain 是叶子"的分层意图
- `src/sessions/session-topology-repair.ts` 实际是 topology-factory 的应用层消费者，不属于持久化层
- `src/project/` 维护 `WorkflowState`（4-step 状态机），但同名概念 `CanonicalTsnProjectV0` 是数据快照，两者长期混淆

E2E 层面：

- 仅 `e2e/specs/ui-smoke.spec.ts` 一条，从输入意图走到 simulation 导出
- 缺：会话切换 / 拓扑编辑（环形互联、改 host 数）/ 错误恢复 / runtime-unavailable CTA / planner 任务 / diagnostics 抽屉

---

## 关键决策

### 决策 1：App.tsx 拆分采用 hook + 组件并行策略，不引入状态管理库

不引入 zustand / jotai / Redux 等外部依赖。理由：

- 当前状态彼此低耦合，提到组件树外只会增加复杂度
- 引入新依赖 = 改架构 + 改测试 + 长尾迁移，超出本次重构范围
- React 自带 useReducer / context 足以承载所有跨组件协调

拆分目标产物（每个文件 ≤300 行）：

| 类型 | 路径 | 内容 |
|---|---|---|
| hook | `src/app/hooks/use-session-repository.ts` | sessions/current state + hydration + new/select/duplicate/delete |
| hook | `src/app/hooks/use-agent-run-controller.ts` | isAgentRunning / phase / elapsed / chunk-stall / submitIntent |
| hook | `src/app/hooks/use-planner-run.ts` | baseUrl / start / stop / poll / attach / fingerprint |
| hook | `src/app/hooks/use-project-export.ts` | exportDirectory / refreshBundle / handleExportProject |
| 组件 | `src/app/components/WorkspaceToolRail.tsx` + 同目录 `WorkspaceToolDrawer/SessionToolPanel/SkillToolPanel/SettingsToolPanel/ReleaseNoteDetail` | 左侧抽屉一组 |
| 组件 | `src/app/components/ChatPane.tsx` + `Step/AgentWaitingIndicator/LegacyOriginBanner` | 中间会话区 |
| 组件 | `src/app/components/WorkspacePane.tsx` + 子组件 `TopologyStage/ConfigTabs/FlowsPanel/NodeDetailPanel/LinkDetailPanel/ArtifactsPanel` | 右侧工作区 |
| 组件 | `src/app/components/AgentStepStream.tsx` | AgentStepSummaryGroup + AgentStepDetailView + 派生函数 |
| 组件 | `src/app/components/AgentRunStatusBar.tsx` | 顶部 elapsed/phase 状态条 |
| 组件 | `src/app/components/PlannerTaskPanel.tsx` | planner 卡片 |
| 工具 | `src/app/utils/format.ts` | formatTime / normalizeError 等 UI 工具 |

`App.tsx` 重构后预期 ≤300 行，只剩 hook 组合 + 顶层布局。

### 决策 2：模块边界修正只做 3 个动作

仅做明确收益的最小调整，不重构内部实现：

1. 移动 `src/domain/topology-factory.ts` → `src/topology/topology-factory.ts`
2. 移动 `src/sessions/session-topology-repair.ts` → `src/topology/project-from-messages.ts`（同时改名以反映职责）
3. 重命名 `src/project/` → `src/workflow/`；本次只改 directory 名 + import 路径，内部文件名（`project-state.ts` 等）和 `ProjectState` 类型保持不变（type rename 推到后续 PR）

不做的事：

- 不合并 `intermediate.ts` 和 `canonical.ts`（双 schema 是正确分层）
- 不重命名 `domain/validation.ts`（命名相似但风险低）
- 不动 `topology/topology-service.ts` 内部
- 不重写 sessions / planner / export 接口

### 决策 3：E2E 覆盖矩阵（6 条新 spec）

| spec | 覆盖路径 |
|---|---|
| 已有：`ui-smoke.spec.ts` | beginner happy path → 全阶段确认 → 导出 |
| 新：`session-switching.spec.ts` | 新建 / 切换 / 删除会话 + 切换后 current 保持 |
| 新：`topology-editing.spec.ts` | 多轮拓扑编辑（改交换机数 / 改 host 数 / 环形互联）保留历史 |
| 新：`runtime-unavailable.spec.ts` | Web 环境 fail-closed + 下载桌面版 CTA |
| 新：`diagnostics-drawer.spec.ts` | 日志抽屉打开 / 日志详情展开 / 跨会话隔离 |
| 新：`planner-flow.spec.ts` | planner baseUrl 录入 / start / stop / 结果挂载 |
| 新：`error-recovery.spec.ts` | 模拟 agent 错误响应后保留前一版 project + 失败提示 |

Playwright 现有 webServer 跑 vite dev，所有 spec 共用 Web fail-closed runtime（不调真实 Claude），所以 e2e 用 `mock` flag 或拦截 invoke 控制 result。具体策略在 plan 阶段决定。

---

## 范围边界

### 在范围

- App.tsx 切分为 hooks + components，每个文件 ≤300 行
- 3 个目录边界修正（domain → topology、sessions → topology、project → workflow）
- 6 条新 Playwright spec
- 所有 vitest 通过 + tsc clean + cargo test 通过 + playwright e2e 通过
- 必要的 import path 替换 + import 顺序梳理（不改业务逻辑）

### 不在范围

- `src-node/claude-agent-worker.mjs` 拆分（独立 follow-up，1820 行内部状态机风险高）
- `src/agent/agent-adapter.ts` 拆分（已经 U1-U3 重构过，趋于稳定）
- `src-tauri/src/commands.rs` 拆分（Rust 侧独立 PR 更合理）
- 统一 redact 实现（涉及 4 个模块，需独立讨论）
- 引入状态管理库或 React Context 重写
- 改任何业务逻辑、错误恢复策略、persistence schema
- UI 视觉变更或交互调整

### 显式不会动的文件

- `src-tauri/` 下任何 Rust 文件
- `src-node/` 下任何 worker / runner / MCP server
- `src/agent/agent-adapter.ts` 内部逻辑（只允许改 import 路径）
- `src/domain/canonical.ts`、`scenario-config.ts` 类型定义
- `src/topology/` 内部除新增 facade 入口外都不动
- `src/sessions/session-repository.ts` 持久化协议

---

## 验证标准

1. `npm test` → 全部通过，期望 ≥317 条（保持现有数量，新拆 hook 必须有单测）
2. `./node_modules/.bin/tsc --noEmit` → 0 错误
3. `npm run cargo:test` → 全部通过（Rust 侧不变，作为回归网）
4. `npm run e2e:ui-smoke` → 7 条全部通过（1 现有 + 6 新增）
5. `find src/app -name "*.tsx" -o -name "*.ts" | xargs wc -l | grep -v test | awk '$1 > 300'` → 输出为空（每文件 ≤300 行硬约束）
6. `grep -r "from.*src/project" src/` → 输出为空（重命名完成）
7. `grep -r "from.*domain/topology-factory" src/ src-node/` → 输出为空（移位完成）

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 大规模 import 路径替换可能造成隐式破坏 | 每个拆分单元独立 commit；每 commit 后跑 `tsc --noEmit` + 相关测试；按 hook → 组件 → 边界目录顺序推进，最后做 import 收尾 |
| 抽 hook 时丢状态依赖（useEffect deps、useRef 共享） | hook 抽离前先写 characterization-style 单测（保证现有行为不变）；hook 单测对 useEffect 触发次数和 dep 数组做断言 |
| E2E 需要 fail-closed 拦截 Tauri invoke | 在 Web 模式下自动 fail-closed，已有 runtime-unavailable 路径；新增 spec 需先在 page.evaluate 里 mock `window.__TAURI_INTERNALS__` 或使用 stage-dispatcher 类似的拦截层 |
| `src/project/` → `src/workflow/` 改名波及大量 import | 用 sed 批量替换 + tsc 验证；保留 `src/project/index.ts` re-export 一个 commit 周期，下一个 commit 删（避免单 commit 改动面过大） |
| 重构期间 PR #2 仍在 review，可能 conflict | 重构 branch base 设为 `feat/agent-runtime-session-experience`（PR #2 head），PR #2 merge 后再 rebase 到 main |

---

## 后续工作（不在本次 PR）

- worker 拆分：`src-node/agent-worker/` 子目录（index / cli / prompts / sdk-message / operation-trace / agent-step / stage-result / audit / redact / paths）
- adapter 拆分：`src/agent/adapter/` 子目录（tauri-bridge / watchdog / failure-results / conversation-context / stage-apply / stage-events / assistant-text-sanitizer）
- commands.rs 拆分：`src-tauri/src/commands/` 子目录（agent_run / worker_io / audit_export / validation / redact）
- 统一 redact：抽"敏感字段表 + 脱敏策略"作为单一真源，4 个模块共用
- `src/domain/validation.ts` 改名 `canonical-validation.ts` 减少与 `topology/validate.ts` 视觉混淆
