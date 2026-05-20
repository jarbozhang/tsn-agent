---
title: "feat: 构建 TSN Agent Tauri MVP"
type: feat
status: active
date: 2026-05-20
origin: docs/brainstorms/2026-05-20-tsn-agent-tauri-ned-requirements.md
---

# feat: 构建 TSN Agent Tauri MVP

## 摘要

把根目录建设成一个可运行、可测试的 Tauri + React MVP，但首要交付目标不是完整工作台平台，而是一条可演示的新手纵向闭环：用户输入一句拓扑意图，fake agent 生成 canonical TSN 模型、`network.ned`、React Flow 拓扑 JSON 和一条控制流 `flow_plan_1.json`，右侧只读展示结果与文件用途。

完整 SQLite 会话管理、真实 Claude bridge、桌面壳 E2E、文档一致性测试和旧 `tsn-topology` skill 迁移都放到纵向闭环通过后的 hardening 阶段。

---

## 问题背景

需求文档定义了面向 TSN 新手的配置应用。用户的核心痛点是不了解大量 TSN 参数，不知道如何从“4 个交换机，每个交换机连接 5 个端系统”走到可用于规划和仿真的配置文件。

当前计划要避免两个偏差：

- 不要把 MVP 做成完整平台工程，导致很晚才验证新手体验。
- 不要把历史 Qunee `topology.json` 或 `tsn-topology/` 的旧契约继续作为新应用主模型。

---

## 计划需求

计划内需求使用 `PR#`，避免和来源文档的 `R1-R25` 混淆。

- PR1. 搭建根目录 Tauri + React 应用，并初始化根目录 git 边界。
- PR2. 保护 `tsn-topology/` 嵌套仓库状态；未确认归属前不修改其中内容。
- PR3. 建立最小测试基础：TypeScript/Vitest、React 组件测试、一个 Web smoke/E2E 入口。
- PR4. 定义 `CanonicalTsnProjectV0`，只强校验 MVP 当前消费者需要的字段。
- PR5. 生成 MVP 三类交付文件：`network.ned`、React Flow 拓扑 JSON、`flow_plan_1.json`。
- PR6. 在 U4 前固定最小 NED contract，包括目标 INET 版本、package/import、module 和 channel/datarate 语法。
- PR7. 提供一条控制流模板和少量默认值解释，避免自动生成完整业务流矩阵。
- PR8. 实现步骤快照和 staged export，保证导出文件不出现新旧混杂。
- PR9. 实现最小会话持久化：当前会话、最近会话列表、canonical state、快照和 manifest；完整复制/删除/搜索后置。
- PR10. 实现 fake agent 纵向链路；真实 Claude SDK/wrapper 接入后置到 hardening。
- PR11. 实现新手优先 UI：首屏以对话和当前工程状态为主，会话侧栏和高级检索渐进披露。
- PR12. 添加本地安全护栏：Tauri capability 最小化、路径 canonicalize、manifest guard、敏感信息不落库。

### 来源需求映射

| 计划需求 | 来源需求 |
|---|---|
| PR1 | 实施前置条件，支撑全部来源需求 |
| PR2 | R13 的 Qunee 降级，以及嵌套仓库安全约束 |
| PR3 | 用户新增测试框架要求 |
| PR4 | R10, R15-R17 |
| PR5, PR6 | R11, R14, R18, R19 |
| PR7 | R4, R5, R15, R17 |
| PR8 | R7, R11, R19 |
| PR9 | R20-R25 |
| PR10 | R6, R8 |
| PR11 | R1-R3, R8, R9 |
| PR12 | R23-R25 |

---

## 范围边界

MVP 包含：

- fake agent 驱动的一句话拓扑输入流程。
- 一个当前会话和最近会话列表。
- `CanonicalTsnProjectV0`。
- 最小 NED contract spike 和对应 exporter。
- React Flow 拓扑 JSON exporter。
- 一条控制流模板和 `flow_plan_1.json` exporter。
- 步骤快照、staged export、manifest。
- 新手优先只读 UI。
- 一个 Web E2E 验证核心纵向闭环。

MVP 不包含：

- 真实规划器执行。
- GCL/WCTA 展示或 `flow_plan_result_1.json` 内容摘要。
- 完整 INET INI、gPTP、TAS、CBS、stream redundancy 导出。
- 完整会话复制、删除项目目录、复杂搜索/筛选、FTS5、损坏恢复。
- 真实 Claude SDK/wrapper/sidecar 接入。
- 桌面壳 E2E 自动化。
- 文档一致性测试。
- 修改 `tsn-topology/SKILL.md` 或 `tsn-topology/docs/rules.md`。
- 跨设备同步、多人协作、云端账户、RBAC 或字段级加密。

### Hardening 阶段

- 完整 SQLite 会话管理：复制、删除、搜索、筛选、软删除/purge。
- 真实 Claude Agent SDK 或 wrapper 接入。
- Tauri command/Rust-side DB 覆盖扩展。
- 桌面壳 E2E opt-in。
- 规划器结果摘要和后续仿真衔接。
- 旧 `tsn-topology` skill 迁移或替代。
- 文档一致性测试和更完整开发者文档。

---

## 关键技术决策

- **纵向闭环优先。** 先证明新手从一句话到导出文件的路径可用，再扩展会话平台和真实 agent bridge。
- **Canonical V0 收窄。** 强校验节点、端口、链路、速率、位置、示例流端点和流参数。同步/INI 相关内容先放 `simulationHints`，不作为 MVP 阻塞校验。
- **NED contract 先冻结。** 在 exporter 前完成最小 contract spike，避免 golden fixture 只锁住字符串但不能被 INET/OMNeT++ 消费。
- **SQLite 是最小恢复层。** MVP 使用 SQLite 保存当前会话、最近会话、canonical state、快照和 manifest。复杂检索和完整会话生命周期后置。
- **Fake agent 先行。** MVP 用 fake agent event contract 验证产品体验；真实 Claude 接入保持 adapter seam，但不阻塞第一纵向切片。
- **右侧只读，修改回到对话。** 右侧可以提供“让 Agent 解释/修改此项”的上下文动作，但不暴露专家参数表单。
- **项目目录是交付边界。** `.ned`、React Flow JSON、`flow_plan_1.json` 和 manifest 必须写入项目目录，不以 SQLite 作为唯一来源。

---

## 输出结构

    .
    ├── docs/
    │   ├── adr/
    │   ├── brainstorms/
    │   └── plans/
    ├── e2e/
    │   ├── fixtures/
    │   └── specs/
    ├── src/
    │   ├── agent/
    │   ├── app/
    │   ├── domain/
    │   ├── export/
    │   ├── project/
    │   ├── sessions/
    │   ├── test/
    │   └── ui/
    ├── src-tauri/
    │   ├── capabilities/
    │   └── src/
    └── tests/
        └── fixtures/

---

## 高层技术设计

```mermaid
flowchart TB
    Intent[自然语言 TSN 意图] --> Agent[Fake agent events]
    Agent --> Domain[CanonicalTsnProjectV0]
    Domain --> Snapshot[步骤快照]
    Domain --> Ned[network.ned]
    Domain --> Flow[React Flow JSON]
    Domain --> Planner[flow_plan_1.json]
    Snapshot --> Session[最小 SQLite 会话]
    Ned --> Project[项目目录]
    Flow --> Project
    Planner --> Project
    Project --> UI[只读工程状态]
```

---

## 实施单元

```mermaid
flowchart TB
    U1[U1 Git 和脚手架] --> U2[U2 最小测试基础]
    U2 --> U3[U3 NED contract spike]
    U3 --> U4[U4 Canonical V0]
    U4 --> U5[U5 导出器和流模板]
    U5 --> U6[U6 快照和安全导出]
    U6 --> U7[U7 最小会话持久化]
    U7 --> U8[U8 Fake agent 纵向链路]
    U8 --> U9[U9 新手优先 UI]
    U9 --> U10[U10 核心 Web E2E]
    U10 --> U11[U11 MVP 文档]
```

### U1. 建立根仓库和应用脚手架

**目标：** 建立根目录应用边界，同时保护 `tsn-topology/` 嵌套仓库。

**需求：** PR1, PR2, PR12

**依赖：** 无

**文件：**
- 新建：`.gitignore`
- 新建：`package.json`
- 新建：`tsconfig.json`
- 新建：`vite.config.ts`
- 新建：`index.html`
- 新建：`src/main.tsx`
- 新建：`src/app/App.tsx`
- 新建：`src-tauri/Cargo.toml`
- 新建：`src-tauri/tauri.conf.json`
- 新建：`src-tauri/build.rs`
- 新建：`src-tauri/src/main.rs`
- 新建：`src-tauri/src/lib.rs`
- 新建：`src-tauri/capabilities/default.json`

**方案：**
- 初始化根目录 git 或记录用户选择的替代方案。
- 记录 `tsn-topology/` 当前 `.git`、修改和未跟踪文件状态。
- 明确门禁：未确认 `tsn-topology/` 是 submodule、vendor copy、迁移源还是独立参考前，不修改其中任何文件。
- Tauri capability 默认最小化，只允许主窗口调用已列明的 app commands；不启用未使用的 shell/fs/open 泛用能力。

**测试场景：**
- 成功路径：根应用能启动最小 App shell。
- 成功路径：`tsn-topology/` 状态被记录，且没有被移动、改写或删除。

**验证：**
- 根目录具备最小 Tauri + React 入口。
- `.gitignore` 覆盖 Node、Rust、Tauri build、测试产物和项目导出产物。

---

### U2. 添加最小测试基础

**目标：** 建立足够支撑 MVP 纵向切片的测试入口，不搭完整平台级测试矩阵。

**需求：** PR3

**依赖：** U1

**文件：**
- 新建：`vitest.config.ts`
- 新建：`src/test/setup.ts`
- 新建：`src/app/App.test.tsx`
- 新建：`playwright.config.ts`
- 新建：`e2e/specs/smoke.spec.ts`
- 修改：`package.json`

**方案：**
- Vitest 覆盖 domain/export/project/session 的纯逻辑测试和关键 React 组件测试。
- Playwright 先只提供 Web smoke/E2E，不引入桌面壳自动化。
- 不添加文档一致性测试。
- `package.json` 默认测试入口不运行桌面壳 E2E。

**测试场景：**
- 成功路径：App shell 渲染出对话区和工程状态区 landmark。
- 成功路径：Playwright 能打开 Web app 并完成 smoke。

**验证：**
- 后续 domain/export/UI 单元可以直接添加测试。
- 桌面壳 E2E 只在文档中作为 hardening opt-in 记录。

---

### U3. 固定最小 NED contract

**目标：** 在写 exporter 前固定 MVP `.ned` 的最小可用契约。

**需求：** PR5, PR6

**依赖：** U2

**文件：**
- 新建：`docs/inet-ned-contract.md`
- 新建：`tests/fixtures/ned/minimal-four-switches.expected.ned`

**方案：**
- 固定目标 INET/OMNeT++ 版本假设。
- 固定 NED package/import、主机 module、交换机 module、channel/datarate 语法和展示坐标写法。
- 明确 MVP 只保证最小有线拓扑结构，不生成完整 INI。
- 如果本机没有 INET 校验工具，先使用文本 fixture，并在文档中标注后续要接入真实 INET 校验。

**测试场景：**
- 成功路径：最小 4 交换机、20 端系统 topology 的 expected NED 包含 package/import、submodules、connections、datarate 和 display position。

**验证：**
- U4/U5 不再自行猜测 NED module/import。

---

### U4. 定义 CanonicalTsnProjectV0

**目标：** 定义只服务 MVP 当前消费者的 canonical 模型。

**需求：** PR4, PR7

**依赖：** U3

**文件：**
- 新建：`src/domain/tsn-model.ts`
- 新建：`src/domain/tsn-validate.ts`
- 新建：`src/domain/tsn-defaults.ts`
- 新建：`src/domain/tsn-model.test.ts`
- 新建：`tests/fixtures/topologies/four-switches-twenty-ends.canonical.json`
- 新建：`tests/fixtures/topologies/simple-control-flow.canonical.json`

**方案：**
- 强校验当前消费者字段：节点、端口、链路、链路速率、位置、稳定 ID、示例流端点、周期、帧长、优先级/PCP 意图、时延目标。
- 同步和未来 INI 信息先放入 `simulationHints`，不因缺少 gPTP/TAS/CBS 细节阻塞 MVP 导出。
- 不继承 Qunee `imac` 作为主键。

**测试场景：**
- 成功路径：4 交换机、20 端系统 canonical fixture 校验通过。
- 成功路径：简单控制流 fixture 校验通过。
- 错误路径：重复 node ID、端口复用、非法链路速率、流端点不存在会失败。
- 边界情况：缺少未来 INI hints 不阻塞 MVP 校验。

**验证：**
- 导出器只依赖 `CanonicalTsnProjectV0`，不读取 `topology.json`。

---

### U5. 实现导出器和一条控制流模板

**目标：** 从 canonical V0 派生 MVP 三类文件，并生成一条控制流示例。

**需求：** PR5, PR7

**依赖：** U4

**文件：**
- 新建：`src/export/ned-exporter.ts`
- 新建：`src/export/react-flow-exporter.ts`
- 新建：`src/export/flow-plan-exporter.ts`
- 新建：`src/export/planner-result-recognizer.ts`
- 新建：`src/export/exporters.test.ts`
- 新建：`src/domain/flow-templates.ts`
- 新建：`src/domain/flow-templates.test.ts`
- 新建：`tests/fixtures/exports/four-switches-twenty-ends.network.ned`
- 新建：`tests/fixtures/exports/four-switches-twenty-ends.react-flow.json`
- 新建：`tests/fixtures/exports/simple-control-flow.flow_plan_1.json`

**方案：**
- NED exporter 严格实现 U3 contract。
- React Flow exporter 输出只读拓扑展示需要的 nodes/edges 和端口/链路摘要。
- `flow_plan_1.json` exporter 使用当前样例格式，但隔离在 exporter 内。
- 控制流模板只生成一条示例流，不生成完整业务流矩阵。
- `flow_plan_result_1.json` 只做 recognizer：识别文件类型和 manifest 分类，不解析 GCL/interface 摘要。

**测试场景：**
- 成功路径：同一 canonical fixture 导出稳定 `network.ned`。
- 成功路径：同一 canonical fixture 导出稳定 React Flow JSON。
- 成功路径：控制流 fixture 导出 `flow_plan_1.json`。
- 成功路径：`flow_plan_result_1.json` 被识别为规划器输出，但不展示 GCL/interface 摘要。
- 错误路径：无效 canonical 不产出部分结果。

**验证：**
- AE1 和 AE2 的文件产物可由测试 fixture 覆盖。

---

### U6. 实现步骤快照和安全导出

**目标：** 管理步骤级快照，并安全写入项目目录。

**需求：** PR8, PR12

**依赖：** U5

**文件：**
- 新建：`src/project/project-state.ts`
- 新建：`src/project/snapshots.ts`
- 新建：`src/project/export-manifest.ts`
- 新建：`src/project/project-writer.ts`
- 新建：`src/project/project-state.test.ts`
- 新建：`src/project/project-writer.test.ts`

**方案：**
- 支持拓扑、流模板和导出步骤快照。
- staged export：先写 staging，校验 manifest，再替换可见输出。
- `project_path` 必须 canonicalize。
- 拒绝根目录、home、repo 根、app config、相对路径逃逸和 symlink 逃逸。
- 删除项目目录不在 MVP 中实现；hardening 阶段如需删除，必须只删除带本应用 manifest 且 session id 匹配的目录。

**测试场景：**
- 成功路径：快照可回退，后续导出状态失效。
- 成功路径：manifest 正确标记 NED、React Flow JSON、规划器输入。
- 错误路径：写盘前校验失败不替换输出。
- 错误路径：危险路径和 symlink 逃逸被拒绝。

**验证：**
- 项目目录可独立交付给规划器和 INET/OMNeT++ 后续流程。

---

### U7. 实现最小 SQLite 会话持久化

**目标：** 支撑 MVP 恢复当前工作，不建设完整会话平台。

**需求：** PR9, PR12

**依赖：** U6

**文件：**
- 新建：`src/sessions/session-model.ts`
- 新建：`src/sessions/session-repository.ts`
- 新建：`src/sessions/session-repository.test.ts`
- 新建：`src-tauri/src/db.rs`
- 新建：`src-tauri/src/migrations.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/tauri.conf.json`
- 修改：`src-tauri/Cargo.toml`

**方案：**
- 使用 Tauri SQL plugin v2 和一条初始 migration。
- MVP 只保存当前会话、最近会话列表、canonical state、快照、manifest 和项目路径。
- 基础搜索只支持名称和最近会话列表；标签、备注、最近消息摘要、FTS5 后置。
- 不保存 raw stdout/stderr、环境变量、凭证样式字符串、Claude Code 配置内容或下游敏感配置。
- 写入前做基础 secret redaction。
- raw SQL 只集中在 `session-repository.ts`；UI 和 agent 模块不直接导入 SQL plugin。

**测试场景：**
- 成功路径：创建/读取当前会话，恢复 canonical state 和 manifest。
- 成功路径：最近会话列表可读取。
- 错误路径：敏感字段被 redaction 后不进入 SQLite。
- 边界情况：空数据库时创建默认会话。

**验证：**
- 会话恢复不阻塞 fake-agent 纵向闭环。
- 完整复制、删除、复杂搜索明确留到 hardening。

---

### U8. 实现 fake agent 纵向链路

**目标：** 用确定性的 fake agent 事件验证对话到模型更新的产品路径。

**需求：** PR10, PR11, PR12

**依赖：** U7

**文件：**
- 新建：`src/agent/agent-events.ts`
- 新建：`src/agent/fake-agent-adapter.ts`
- 新建：`src/agent/agent-session.test.ts`
- 新建：`src-tauri/src/commands.rs`
- 新建：`src-tauri/src/project_io.rs`
- 修改：`src-tauri/src/lib.rs`

**方案：**
- 定义最小 agent event：assistant 文本、状态、canonical model update、export request、error。
- fake adapter 对输入“4 个交换机，每个交换机连接 5 个端系统”返回确定性拓扑和后续控制流。
- 真实 Claude SDK/wrapper 只保留 adapter seam，不在 MVP 实现。
- 所有模型更新事件必须通过 schema 校验后才能修改 project state 或触发写盘。
- Tauri command capability 只开放 MVP 必需命令。

**测试场景：**
- 成功路径：fake adapter 输出拓扑事件、控制流事件和导出事件。
- 错误路径：非法 model update 被拒绝，不修改 project state。
- 错误路径：agent error 进入对话状态，不破坏当前快照。

**验证：**
- UI 和 E2E 不依赖真实 Claude 凭证。

---

### U9. 实现新手优先 UI

**目标：** 构建首个可演示的新手界面，而不是完整工作台。

**需求：** PR11

**依赖：** U8

**文件：**
- 新建：`src/ui/layout/AppShell.tsx`
- 新建：`src/ui/chat/ConversationPane.tsx`
- 新建：`src/ui/topology/TopologyFlow.tsx`
- 新建：`src/ui/project/GeneratedFilesPanel.tsx`
- 新建：`src/ui/project/SnapshotTimeline.tsx`
- 新建：`src/ui/flows/FlowSummaryPanel.tsx`
- 新建：`src/ui/explain/DefaultsExplanationPanel.tsx`
- 新建：`src/ui/sessions/RecentSessionsButton.tsx`
- 新建：`src/app/app-state.ts`
- 新建：`src/app/App.integration.test.tsx`
- 新建：`src/ui/topology/TopologyFlow.test.tsx`

**方案：**
- 首屏默认只显示对话区和当前工程状态摘要。
- 会话入口默认收起，只展示最近会话；完整侧栏、复制、删除、复杂搜索后置。
- 右侧按阶段渐进披露：
  - 拓扑阶段：拓扑图和关键默认值。
  - 流阶段：一条控制流和参数解释。
  - 导出阶段：文件 readiness 和 manifest。
  - 快照：默认 compact stepper，只有用户请求回退时展开。
- 右侧保持只读；提供单一上下文动作“让 Agent 解释/修改此项”，回到对话路径。
- 响应式要求覆盖单栏、双栏和桌面三种布局；键盘顺序和 ARIA landmarks 覆盖会话入口、对话区和工程状态区。

**测试场景：**
- 成功路径：fake agent 生成拓扑后，右侧显示拓扑和文件状态。
- 成功路径：选择控制流后，显示一条示例流和解释。
- 成功路径：右侧没有专家参数编辑表单。
- 成功路径：上下文动作把修改请求送回对话区。
- 边界情况：未选择流模板时显示空状态，不阻塞拓扑检查。

**验证：**
- 新手可以从一句话进入配置流程，界面不要求理解底层参数表。

---

### U10. 添加核心 Web E2E

**目标：** 用一个确定性 Web E2E 验证 MVP 纵向闭环。

**需求：** PR3, PR5, PR7, PR8, PR10, PR11

**依赖：** U9

**文件：**
- 新建：`e2e/specs/new-project-export.spec.ts`
- 新建：`e2e/fixtures/fake-agent-session.json`
- 新建：`e2e/fixtures/generated-project.expected.json`
- 新建：`e2e/desktop/README.md`
- 修改：`playwright.config.ts`
- 修改：`package.json`

**方案：**
- E2E 只使用 fake agent 和 isolated app data。
- 验证一句话拓扑输入、控制流模板、右侧只读展示和三类导出文件。
- `e2e/desktop/README.md` 只记录未来桌面壳 opt-in 方法，不新增 `e2e/desktop/smoke.spec.ts`。

**测试场景：**
- 成功路径：输入“4 个交换机，每个交换机连接 5 个端系统”，生成拓扑展示。
- 成功路径：选择控制流，生成一条示例流和 `flow_plan_1.json`。
- 成功路径：导出目录包含 `network.ned`、React Flow JSON、`flow_plan_1.json` 和 manifest。
- 错误路径：fake agent 错误显示在对话区，且不创建导出成功状态。

**验证：**
- MVP 是否成立由这个核心 Web E2E 和 exporter fixtures 共同判断。

---

### U11. 更新 MVP 文档

**目标：** 提供足够运行和交付的文档，不建设完整开发者文档体系。

**需求：** PR1, PR3, PR5, PR9, PR12

**依赖：** U10

**文件：**
- 新建：`README.md`
- 新建：`docs/testing.md`
- 新建：`docs/mvp-export-contract.md`
- 修改：`docs/adr/0001-local-sqlite-session-store.md`

**方案：**
- README 说明如何运行应用、运行测试、生成 MVP 导出。
- `docs/testing.md` 只列 MVP 必需测试和 hardening opt-in 测试。
- `docs/mvp-export-contract.md` 说明 `network.ned`、React Flow JSON、`flow_plan_1.json`、manifest 和 SQLite 的边界。
- ADR 同步注明 SQLite MVP 先做最小恢复层，完整会话管理后置。
- 不修改 `tsn-topology/` 中的文件。
- 不新增 `src/test/docs-consistency.test.ts`。

**测试场景：**
- 文档不设自动一致性测试；由 U10 和单元测试覆盖实际行为。

**验证：**
- 新实现者能跑起 MVP，并理解哪些内容属于 hardening。

---

## Hardening backlog

- 完整会话侧栏：创建、切换、重命名、复制、删除、搜索、筛选。
- 会话删除项目目录：manifest guard、二次确认、purge、文件数量展示。
- 真实 Claude Agent SDK 或 wrapper/sidecar 接入。
- `docs/agent-bridge.md` 和更完整 bridge 安全契约。
- 桌面壳 E2E：`tauri-driver` opt-in，不进入默认 test。
- `flow_plan_result_1.json` 结果摘要、GCL/interface 只读展示。
- 完整 INET INI / `inet-export` skill。
- 旧 `tsn-topology` skill 迁移或替代。
- 文档一致性测试。
- FTS5、标签、备注、最近消息摘要和数据库损坏恢复。

---

## 系统级影响

- **核心闭环：** fake agent -> canonical V0 -> exporters -> project writer -> read-only UI。
- **数据边界：** SQLite 只保存最小恢复状态；项目目录仍是对外交付边界。
- **安全边界：** 本地 MVP 不做云端权限体系，但必须做好 Tauri capability、路径安全、manifest guard 和敏感信息不落库。
- **测试边界：** MVP 必需测试证明模型、导出和一条 Web 纵向流程；桌面壳和文档一致性后置。
- **迁移边界：** `tsn-topology/` 在归属决策前只读参考。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 纵向闭环仍被基础设施拖慢 | U1-U2 只做最小脚手架和测试入口，U10 作为 MVP gate。 |
| NED fixture 不代表真实 INET 可用 | U3 先固定最小 NED contract，后续接入真实 INET 校验。 |
| Canonical 模型过度膨胀 | 使用 `CanonicalTsnProjectV0`，未来 INI 字段先放非阻塞 `simulationHints`。 |
| SQLite schema 过早复杂化 | MVP 只做当前会话和最近会话恢复，完整会话平台进入 hardening。 |
| 项目导出或删除触达危险路径 | MVP 不实现删除项目目录；导出路径 canonicalize 并拒绝危险目录。 |
| Claude 集成阻塞产品验证 | MVP 使用 fake agent；真实 Claude bridge 后置。 |
| `tsn-topology/` 脏状态被误改 | U1 记录状态并设置门禁，MVP 不修改嵌套仓库。 |

---

## 来源与参考

- 来源文档：`docs/brainstorms/2026-05-20-tsn-agent-tauri-ned-requirements.md`
- 原型参考：`docs/prototypes/tsn-agent-prototype-20260509-1430.html`
- 现有拓扑 skill：`tsn-topology/SKILL.md`
- 现有拓扑规则：`tsn-topology/docs/rules.md`
- 现有 fixture 回归模式：`tsn-topology/tests/run-e2e.js`
- 规划器输入样例：`tests/fixtures/planner/flow_plan_1.json`
- 规划器输出样例：`tests/fixtures/planner/flow_plan_result_1.json`
- Qunee 时代拓扑样例：`tests/fixtures/legacy-qunee/topology.json`
- Tauri v2 文档：https://v2.tauri.app/
- Vitest 文档：https://vitest.dev/
- Playwright 文档：https://playwright.dev/
- React Flow 文档：https://reactflow.dev/
- INET Framework 文档：https://inet.omnetpp.org/
- Tauri SQL Plugin 文档：https://github.com/tauri-apps/tauri-plugin-sql
- 架构决策：`docs/adr/0001-local-sqlite-session-store.md`
