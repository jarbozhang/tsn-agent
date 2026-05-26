---
title: "feat: 支持 Skill 文件预览与轻量编辑"
type: feat
status: completed
date: 2026-05-26
origin: user request
---

# feat: 支持 Skill 文件预览与轻量编辑

## 摘要

把 Skill 面板补成一个轻量维护入口：先能看到每个 skill 目录里有哪些文件，点击后预览文本内容；在开发环境里，对小型安全文本文件提供最基础的编辑和保存。第一版不做完整 IDE、不做文件管理、不做复杂 diff/merge。

---

## 问题框架

当前 Skill 面板只能查看和编辑应用内 metadata，看不到真实 skill 文件。用户现在的目标不是建设一个完整文件编辑器，而是先解决两个低成本高价值需求：

- 预览：快速确认 skill 里有哪些文件、每个文件大概写了什么。
- 轻编辑：对 `SKILL.md`、小脚本或小文档做简单文本修改。

实现应保持简单，但仍要有最基本的路径边界，避免变成任意磁盘文件编辑器。

---

## 需求

- R1：Skill 详情里展示该 skill 的文件列表，优先覆盖已落盘的 `.claude/skills/<skillId>`。
- R2：点击文本文件后展示相对路径和文件内容。
- R3：对小型 UTF-8 文本文件提供“编辑/保存/取消”。
- R4：二进制、过大、目录、缺失 skill 根目录、只读资源只展示不可编辑状态。
- R5：前端只传 `skillId` 和相对路径，不传绝对路径。
- R6：后端只允许访问已注册 skill 根目录内的文件，拒绝 `..`、绝对路径和越界路径。
- R7：保留现有 Skill metadata 详情，不因为文件预览改掉 skill 的阶段、id 或业务流程。
- R8：Web/E2E 环境可以展示只读或 mock 状态；真实读写只在 Tauri 桌面环境中做。

---

## 范围边界

- 本计划只做文件列表、文本预览和轻量保存。
- 不做新增、删除、重命名、移动文件。
- 不做完整代码编辑器、语法高亮、diff、历史版本、冲突合并。
- 不默认编辑 `tsn-topology/` 独立参考目录；第一版只处理 `.claude/skills` 下注册的项目 skill。
- 不改变 stage skill 执行协议、规划器流程或 INET 导出流程。
- 不把文件内容写入诊断日志。

### Deferred to Follow-Up Work

- 更完整的文件管理能力。
- 更强的编辑器体验，例如语法高亮、搜索、diff。
- 用户级 skill 工作目录和生产包内置 skill 的可写副本机制。
- 保存后自动运行 skill 校验。

---

## Context & Research

### Relevant Code and Patterns

- `src/app/App.tsx` 已有 `SkillToolPanel`，现在展示 skill 列表、详情和 metadata 编辑。
- `src/skills/skill-catalog.ts` 已定义 `SKILL_CATALOG`，覆盖 `tsn-topology`、`tsn-time-sync`、`tsn-flow-planning`、`tsn-inet-export`。
- 当前已落盘 skill 主要是 `.claude/skills/tsn-topology` 和 `.claude/skills/tsn-flow-planning`；后者目前只有 `SKILL.md`。
- `tsn-time-sync`、`tsn-inet-export` 当前在 catalog 中存在，但未发现对应 `.claude/skills` 目录，UI 应展示“暂无文件目录”而不是报错。
- `src-tauri/src/lib.rs` 通过 `tauri::generate_handler!` 注册 app command。
- `src-tauri/src/project_writer.rs` 有相对路径、symlink 和临时写入相关实现，可借鉴其中简单、必要的安全检查。
- `src/ui/diagnostics/DiagnosticsDrawer.tsx` 已有列表 + 右侧详情的交互模式，可以复用到 Skill 文件预览。

### Institutional Learnings

- `AGENTS.md` 明确 `tsn-topology/` 是独立 skill 仓库/参考目录，不要默认纳入根项目修改范围。
- 当前仓库未发现 `docs/solutions/` 目录。

---

## Key Technical Decisions

- D1：第一版以“预览优先”为目标。文件列表和只读预览是核心路径，编辑是小文本文件上的辅助能力。
- D2：不新增复杂 provider 层。可以用一个很薄的 `skill-file-service` 包住 Tauri invoke 和 Web fallback，避免在第一版引入过多抽象。
- D3：后端只注册少量命令：列文件、读文件、写文件。命令内部做 allowlist 和相对路径校验。
- D4：轻编辑只支持 UTF-8 小文本。大小阈值可先取一个保守值，例如 256KB；超过就只读或不可打开。
- D5：保存先做简单覆盖写入，但必须只写 allowlist 内文件。第一版可以不做复杂冲突合并；如果文件在读取后外部变化，保存失败或提示重新加载即可。
- D6：生产包内置资源如果不可写，直接只读展示，不在第一版做可写副本。

---

## Open Questions

### Resolved During Planning

- 是否需要完整文件编辑器：不需要，先做预览和轻量编辑。
- 是否需要管理文件：不需要，新增/删除/重命名后置。
- 是否支持所有 skill：catalog 都展示；只有有落盘目录的 skill 展示文件，缺目录的展示空态。

### Deferred to Implementation

- 文本大小阈值：实现时按当前 skill 文件大小选择一个小而稳定的限制。
- 生产包资源路径：实现时探测是否能读；不能写时只读展示。
- 是否做保存前 mtime 检查：可实现为轻量 guard，但不要求复杂冲突解决。

---

## Implementation Units

### U1. 增加轻量 Skill 文件 Tauri 命令

**Goal:** 提供列文件、读文本、写文本三个最小后端能力。

**Requirements:** R1, R2, R3, R4, R5, R6, R8

**Dependencies:** None

**Files:**
- Create: `src-tauri/src/skill_files.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/skill_files.rs`

**Approach:**
- 建立固定 skill 根目录映射，第一版只允许 `.claude/skills/<skillId>`。
- `list_skill_files` 返回相对路径、类型、大小和是否可预览/可编辑。
- `read_skill_file` 只读取小型 UTF-8 文本文件。
- `write_skill_file` 只写小型 UTF-8 文本文件，拒绝绝对路径、`..`、目录和越界路径。
- 对不存在目录返回空文件列表或 unavailable，不抛出未处理错误。

**Patterns to follow:**
- `src-tauri/src/project_writer.rs` 的相对路径检查和 Rust 单元测试风格。
- `src-tauri/src/lib.rs` 的 command 注册方式。

**Test scenarios:**
- Happy path：`tsn-topology` 返回 `SKILL.md`、docs 和 tools 文件。
- Happy path：`tsn-flow-planning` 只有 `SKILL.md` 时也能正常返回。
- Happy path：读取小文本文件返回内容。
- Happy path：写入 allowlist 内的小文本文件成功。
- Edge case：`tsn-time-sync` 没有目录时返回 unavailable 或空列表。
- Error path：`../SKILL.md`、绝对路径、目录路径、过大文件、二进制文件都被拒绝。

**Verification:** Rust 测试覆盖基础列读写和路径逃逸拒绝。

### U2. 在 Skill 面板加入文件列表和文本预览

**Goal:** 用户选择 skill 后，能看到它的文件列表并点击预览文本内容。

**Requirements:** R1, R2, R4, R7, R8

**Dependencies:** U1

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.css`
- Modify: `src/app/App.test.tsx`
- Create: `src/ui/skills/SkillFilePreview.tsx`
- Test: `src/ui/skills/SkillFilePreview.test.tsx`

**Approach:**
- 保留现有 skill metadata 区域，在详情下方或相邻区域增加“文件”区。
- 文件列表用相对路径展示，点击后右侧/下方显示文本预览。
- 默认优先选中 `SKILL.md`。
- 没有目录、没有文件、文件不可预览时展示明确空态。
- Web 环境用 mock/readonly fallback，保证普通浏览器测试也能覆盖 UI。

**Patterns to follow:**
- `src/ui/diagnostics/DiagnosticsDrawer.tsx` 的列表选择 + 详情预览。
- `src/app/App.css` 中现有 `.master-detail-layout`、`.detail-surface`、`.master-list-item`。

**Test scenarios:**
- Happy path：打开 Skill 面板后能看到文件区。
- Happy path：点击 `SKILL.md` 展示内容预览。
- Edge case：切换 skill 后文件列表刷新，旧文件内容不会残留。
- Edge case：未落盘 skill 显示“暂无文件目录”。
- Error path：读取失败时显示错误摘要和重试入口。

**Verification:** React 测试覆盖文件列表、预览、空态和切换 skill。

### U3. 加入小文本轻量编辑

**Goal:** 对可编辑文本文件提供最基础的编辑、保存、取消体验。

**Requirements:** R3, R4, R5, R6, R8

**Dependencies:** U1, U2

**Files:**
- Modify: `src/ui/skills/SkillFilePreview.tsx`
- Modify: `src/app/App.css`
- Modify: `src/app/App.test.tsx`

**Approach:**
- 预览区增加“编辑”按钮；点击后用 textarea 展示当前文本。
- 保存按钮只在内容变化且文件可编辑时启用。
- 取消恢复到读取到的原内容。
- 保存成功后回到预览态并显示最新内容。
- 保存失败时保留用户输入，展示简短错误。

**Patterns to follow:**
- 现有 `SkillToolPanel` metadata 编辑的保存/取消交互。
- `src/app/App.css` 的表单和按钮样式。

**Test scenarios:**
- Happy path：点击编辑、修改内容、保存后预览更新。
- Happy path：取消编辑后内容恢复。
- Edge case：只读文件不显示编辑入口或保存按钮禁用。
- Edge case：未修改内容时保存按钮禁用。
- Error path：保存失败时保留 textarea 内容并显示错误。

**Verification:** 组件测试覆盖编辑、保存、取消、只读和失败状态。

---

## System-Wide Impact

- UI：Skill 面板多一个文件区，但保持在工作台内部，不改变顶层导航。
- 后端：新增少量 Tauri command，只服务 `.claude/skills` 的预览和轻编辑。
- 安全：仍有基本 allowlist 和相对路径检查，但不追求完整 IDE 级文件安全模型。
- 测试：以 Rust 路径测试和 React UI 测试为主，E2E 只做轻量冒烟。

---

## Risk Analysis & Mitigation

- 风险：误写非 skill 文件。缓解：后端固定 skill 根目录，只接受相对路径。
- 风险：UI 复杂度膨胀。缓解：第一版只做列表、预览、textarea 编辑，不引入代码编辑器。
- 风险：生产内置 skill 不可写。缓解：只读展示即可，不做可写副本。
- 风险：保存覆盖外部修改。缓解：第一版可用轻量 mtime guard 或失败提示重新加载，不做 merge。

---

## Verification Plan

- 前端构建和类型检查通过。
- React 测试覆盖 Skill 文件列表、预览、编辑保存和空态。
- Rust 测试覆盖 skill 文件命令的基础列读写和路径逃逸拒绝。
- Web E2E 冒烟确认 Skill 面板展示文件区或只读 fallback。
- 手工桌面验证：打开 `tsn-topology` 的 `SKILL.md` 预览，编辑一个小文本文件并保存。
