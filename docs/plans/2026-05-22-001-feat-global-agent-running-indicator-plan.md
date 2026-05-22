---
title: "feat: 添加全局智能助手运行状态"
type: feat
status: completed
date: 2026-05-22
origin: docs/brainstorms/2026-05-20-tsn-agent-tauri-ned-requirements.md
---

# feat: 添加全局智能助手运行状态

## 摘要

把现有“首 token 前的局部等待动画”扩展为“整轮智能助手运行期间持续可见的全局运行状态”。实现后，即使流式文本已经开始、后续因工具调用或子任务长时间没有新 chunk，界面仍会明确显示当前推理尚未结束。

---

## 问题背景

当前 `src/app/App.tsx` 已经在首个流式 chunk 返回前显示 `AgentWaitingIndicator`，但该提示绑定在 pending assistant message 上；一旦收到第一个 chunk，pending 状态会清除。真实 Agent 在流式回复过程中可能继续执行工具、阶段 skill 或子任务，此时没有新 token 返回，但 `runTsnAgent()` 仍未完成，用户容易误以为界面卡住或任务已经结束。

---

## 需求

- R1. 只要当前 `runTsnAgent()` 调用未完成，界面必须持续显示一个用户可见的全局运行状态。
- R2. 首 token 前的局部等待消息继续保留，用于说明“正在连接智能助手并结合上下文生成规划”。
- R3. 首个 chunk 返回后，assistant message 应正常显示流式文本，但全局运行状态不能消失，直到成功、失败或 fallback 完成。
- R4. 当长时间没有新 chunk 时，全局状态文案应表达“仍在推理/等待工具或子任务返回”，避免用户误判为应用空闲。
- R5. 运行状态、错误提示和最终文本必须继续使用“智能助手”等中性文案，不暴露供应商名称。
- R6. 该状态不应写入会话历史或导出文件；它只是当前前端运行态。

**Origin actors:** A1 TSN 新手用户，A2 智能助手，A3 TSN skills
**Origin flows:** F6 分阶段确认和工具可见，F8 真实阶段 skill 调度
**Origin acceptance examples:** AE10 工具/skill 进展可见，AE14 工具权限和脱敏摘要可见，AE16 左侧聊天承载阶段交互

---

## 范围边界

- 不改变 `runTsnAgent()` 的业务结果、阶段状态机、canonical project、bundle 或 session 持久化语义。
- 不解析完整工具调用内容，也不把工具日志塞进聊天正文；详细信息仍在执行步骤和诊断日志。
- 不引入新的后端协议或 SDK 事件类型；第一版以现有前端 pending promise、chunk 回调和完成/失败路径驱动。
- 不在数据库中保存“当前是否正在运行”这类瞬时 UI 状态。

### Deferred to Follow-Up Work

- 更细粒度工具状态：后续真实 SDK tool/skill 事件流稳定后，可以把全局状态文案从“等待工具或子任务”升级为“正在运行 tsn-topology / 正在执行 INET smoke”等具体阶段。

---

## 上下文与调研

### 相关代码和模式

- `src/app/App.tsx` 已有 `isAgentRunning`，从提交需求前置为 `true`，并在 `finally` 中恢复为 `false`，正好代表整轮智能助手请求生命周期。
- `src/app/App.tsx` 的 `pendingAssistantMessageId` 当前只代表“首 chunk 前的 assistant 占位消息”，不适合继续承载全局运行态。
- `src/app/App.test.tsx` 已有 “shows a waiting animation before the first streaming chunk arrives” 测试，可以扩展为覆盖“首 chunk 后全局状态仍存在”。
- `src/app/App.css` 已有 `agent-waiting`、`waitingDot`、`waitingSurface` 等动效，可复用视觉语言，避免新增重型遮罩。
- `src/agent/agent-adapter.ts` 的 `onChunk` 只负责文本 chunk，最终完成仍由 `runTsnAgent()` promise settle 表达；本计划不要求 adapter 暴露新的事件。

### 机构经验

- 未发现 `docs/solutions/` 下有可复用的历史经验文档。

### 外部参考

- 未进行外部调研。该计划主要是现有 React 状态建模和 UI 反馈调整，仓库已有模式足够支撑。

---

## 关键技术决策

- **把“首 token 等待”和“整轮运行中”拆成两个 UI 状态。** `pendingAssistantMessageId` 继续控制局部等待消息；新增或派生的运行态控制全局状态条，避免首 chunk 到达后丢失忙碌反馈。
- **优先复用 `isAgentRunning` 作为权威生命周期。** 该状态已经覆盖 submit、stream、成功、失败和 fallback，不需要把瞬时状态写入 session。
- **用轻量全局状态条，不用全屏遮罩。** 用户仍应能阅读已流出的文本、查看拓扑和执行步骤；状态条只负责说明任务仍在进行。
- **文案按活动阶段降级表达。** 首 chunk 前显示连接/准备语义；首 chunk 后显示持续推理；若超过短阈值没有新 chunk，显示正在等待工具或子任务返回。

---

## 开放问题

### 已在规划中解决

- 全局状态是否需要依赖真实工具事件：第一版不依赖。真实工具事件不稳定时，pending promise 生命周期比事件解析更可靠。
- 是否需要持久化运行态：不需要。运行态只表示当前页面中正在执行的一次请求，刷新或恢复会话后不应伪造“仍在运行”。

### 延后到实现中确认

- 无 chunk 间隔阈值的精确秒数：实现时按 UI 体感和测试可控性选择一个小阈值，例如 2-3 秒；这不改变功能边界。

---

## 实施单元

### U1. 拆分 Agent 运行态和首 chunk 等待态

**目标：** 让前端拥有独立于 assistant message 占位状态的“本轮智能助手仍在运行”状态，为全局 loading 提供稳定来源。

**需求：** R1, R2, R3, R6

**依赖：** 无

**文件：**
- Modify: `src/app/App.tsx`
- Test: `src/app/App.test.tsx`

**方案：**
- 保留 `isAgentRunning` 作为禁用提交按钮和生命周期边界的权威状态。
- 增加轻量 UI 派生状态，例如是否收到首个 chunk、最近一次 chunk 时间、当前 run 开始时间；该状态只存在于 `App` 组件内。
- 在 `submitIntent()` 开始时初始化运行态，在 `onChunk` 中记录首 chunk 和最近 chunk，在 `finally` 中统一清理。
- `pendingAssistantMessageId` 只继续负责首 token 前的局部等待消息；收到 chunk 后清空它，但不影响全局状态。

**Patterns to follow:**
- `src/app/App.tsx` 中 `submitIntent()` 对 `isAgentRunning`、`pendingAssistantMessageId`、`try/catch/finally` 的现有结构。
- `src/app/App.test.tsx` 中 `createDeferred()` 和手动触发 `onChunk` 的测试模式。

**Test scenarios:**
- Happy path：提交需求后，在 promise 未 resolve 且还没有 chunk 时，局部等待消息和全局运行态都可见。
- Happy path：触发 `onChunk("已开始解析拓扑需求")` 后，局部等待消息消失，assistant 文本出现，但全局运行态仍可见。
- Happy path：promise resolve 后，全局运行态消失，提交按钮恢复可用。
- Error path：pending session 保存或 `runTsnAgent()` 抛错后，全局运行态消失，错误消息显示，提交按钮恢复可用。
- Edge case：运行中的会话被删除时，不恢复已删除 session；全局运行态仍在 promise settle 后清理。

**验证：**
- 首 chunk 前、首 chunk 后、完成后三个状态在单元测试中被明确区分。

---

### U2. 添加全局运行状态条和长等待文案

**目标：** 在主界面上提供偏全局的 loading 动效，持续覆盖整轮推理过程，并在长时间没有新 chunk 时给出合理解释。

**需求：** R1, R3, R4, R5

**依赖：** U1

**文件：**
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.css`
- Test: `src/app/App.test.tsx`

**方案：**
- 新增 `AgentRunStatusBar` 或等价组件，放在应用顶部 header 下方或主工作区上沿，保证它不依附于某一条聊天消息。
- 状态条只在 `isAgentRunning` 为 true 时渲染，使用轻量 spinner/dots 或进度 shimmer，避免遮挡拓扑和聊天内容。
- 文案按状态切换：
  - 首 chunk 前：`正在连接智能助手，并结合当前会话上下文生成下一步规划`
  - 首 chunk 后：`智能助手正在持续推理，结果会继续更新`
  - 首 chunk 后一段时间没有新 chunk：`智能助手仍在处理，可能正在等待工具或子任务返回`
- 组件使用 `role="status"`、`aria-live="polite"`；必要时在根容器增加 `aria-busy={isAgentRunning}`，但不影响用户继续阅读页面。
- 样式沿用当前浅色工作台、橙色强调和紧凑布局，不做全屏遮罩，不打断用户查看已生成内容。

**Patterns to follow:**
- `src/app/App.css` 中 `.agent-waiting`、`.badge`、`.brand-header` 和当前紧凑工作台样式。
- `src/app/App.tsx` 中顶部品牌区、聊天区和 composer 的现有状态文案风格。

**Test scenarios:**
- Happy path：提交需求后能通过文本或 role 找到全局运行状态。
- Happy path：触发首个 chunk 后，全局运行状态仍存在，并且不再显示首 token 前的局部等待消息。
- Edge case：模拟长时间没有新 chunk 时，状态文案切换为等待工具或子任务返回。
- Accessibility：全局状态条具有 `role="status"`，运行期间根区域或状态条能被辅助技术识别为忙碌状态。
- Visual regression guard：状态条出现时，发送按钮仍 disabled，聊天和拓扑区域没有被遮挡或替换。

**验证：**
- 用户在任何 token 间隔都能看到“本轮推理尚未完成”的明确提示。

---

### U3. 补充主流程回归覆盖

**目标：** 确保新增全局运行态不会破坏现有阶段推进、流式文本、导出文件和执行步骤体验。

**需求：** R1, R3, R5

**依赖：** U1, U2

**文件：**
- Modify: `src/app/App.test.tsx`
- Test: `src/app/App.test.tsx`
- Test: `e2e/specs/smoke.spec.ts`

**方案：**
- 扩展现有等待动画单元测试，覆盖首 chunk 后全局运行态仍存在和完成后消失。
- 保留现有 smoke E2E 作为主流程回归；只有新增状态条影响现有定位或可访问语义时才调整测试。
- 如果 E2E 环境中 fake agent 太快，不强行在 E2E 里模拟长等待；长等待由单元测试控制 deferred promise 和 timer 覆盖。

**Patterns to follow:**
- `src/app/App.test.tsx` 当前 mock `runTsnAgent`、`userEvent`、`waitFor` 和 deferred promise 的写法。
- `e2e/specs/smoke.spec.ts` 当前主流程烟测范围。

**Test scenarios:**
- Integration：一次完整拓扑生成后，阶段确认按钮、拓扑统计和执行步骤仍正常显示。
- Integration：新增状态条不会导致 E2E 中主要按钮、tab 或导出文件文本定位失败。
- Error path：已有 pending session persistence failure 测试仍证明失败后按钮恢复、运行态消失。

**验证：**
- UI 主流程测试仍通过，新增 loading 行为有专门单元测试覆盖，而不是只靠人工观察。

---

## 系统影响

- **交互关系：** 只影响 `App` 的前端运行态展示；Agent adapter、session repository、workflow state 和 exporter 不需要改变。
- **错误传播：** 错误路径继续由 `catch` 写 assistant 错误消息，`finally` 负责清理全局运行态。
- **状态生命周期风险：** 需要避免 chunk 回调在 session 切换或删除后误更新当前会话；沿用现有 `sessionId` 检查，并让全局状态只跟当前 pending run settle 绑定。
- **API 表面一致性：** 不新增 Tauri command、不改 `runTsnAgent()` 返回结构；最多在 `App` 内部扩展本地 UI state。
- **集成覆盖：** 单元测试覆盖长等待和 chunk 间隔，E2E 保持主流程不回归。
- **不变约束：** 聊天最终内容仍使用智能助手输出；执行步骤仍是工具/skill 时间线；诊断日志仍是调试入口，不被 loading 状态替代。

---

## 风险与依赖

| 风险 | 缓解 |
|------|------|
| 状态条文案过于频繁变化，打扰用户阅读 | 只在首 chunk 前、首 chunk 后和长静默三类状态之间切换，不展示秒表或 token 计数 |
| 全局 loading 被误解为整个应用不可操作 | 使用轻量状态条，不用遮罩；只禁用发送/确认这类会产生并发 Agent run 的动作 |
| 长静默阈值导致测试不稳定 | 单元测试使用 fake timer 或可控时间推进，不依赖真实等待 |
| 未来真实工具事件接入后出现两套状态来源 | 本计划把工具级精细状态明确延后；当前只表达“本轮仍未完成”这个稳定事实 |

---

## 验证策略

- `src/app/App.test.tsx` 覆盖首 token 前、首 chunk 后、长静默、完成、失败清理。
- `e2e/specs/smoke.spec.ts` 继续覆盖真实用户主路径，确认新增状态条不破坏生成、确认、导出和日志入口。
- 手动验证一轮真实 Tauri Agent 调用：在工具/子任务等待期间，首段文本已出现后，顶部仍显示运行状态；最终完成后状态消失。
