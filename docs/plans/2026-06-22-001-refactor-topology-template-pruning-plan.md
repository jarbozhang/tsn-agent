---
title: "refactor: 拓扑模板裁剪——删环形/每交换机挂载，generic-line 重命名为 hop-linear"
date: 2026-06-22
type: refactor
origin: docs/brainstorms/2026-06-22-topology-template-pruning-requirements.md
depth: standard
---

# refactor: 拓扑模板裁剪（删环形 / 每交换机挂载，generic-line → hop-linear）

## Summary

把拓扑 catalog 从三模板（`generic-line` 双模式 / `generic-ring` / `dual-plane-redundant`）收成两模板：`dual-plane-redundant`（不动）+ `hop-linear`（由 `generic-line` 重命名、剥到只剩 ends-only）。删除 `generic-ring`、`generic-line` 的 per-switch 模式，以及 `endSystemsPerSwitch` / `endSystemPlacement` 参数及合法域常量，贯穿 Rust → MCP → skill references → 测试。前端 `scenario-config.ts` 经核实不持拓扑 templateId（只 flowTemplates），不动。不迁移旧数据。

## Problem Frame

`topology_compute.rs` 当前用 `template_id` 字符串派发到三个 descriptor + builder。「跳线性」= `generic-line` + `endSystemPlacement:"ends-only"`；要删的「每交换机挂载」= 同模板的 `per-switch` 模式。删掉 per-switch 后 `generic-line` 只剩一种模式，`endSystemPlacement` 枚举随之多余。`dual-plane-redundant` 用显式 `endSystems`/`attachment`，与本次删除无关。

## Key Technical Decisions

- **KTD1 新 templateId = `hop-linear`**（OQ1 已定）。descriptor 函数 `generic_line_descriptor` → `hop_linear_descriptor`，id 字符串 `"generic-line"` → `"hop-linear"`。
- **KTD2 跳线性参数 = `switchCount`(1–12) + `dataRateMbps`**；删 `endSystemsPerSwitch`、`endSystemPlacement`、`END_SYSTEMS_PER_SWITCH_MIN/MAX` 及对应校验分支（see origin: KTD D1）。switchCount 合法域保持 1–12 不变。
- **KTD3 双平面不动**：`dual-plane-redundant` descriptor / builder / 参数结构 / preset 一律不改（see origin: D2）。
- **KTD4 不迁移旧数据**：库里旧的 `generic-ring` / `generic-line`(含合法 ends-only) 拓扑节点/连线行保留、可显示可编辑；用旧 templateId 重新 initialize 返回「未知 templateId」错（see origin: D4）。
- **KTD5 R9 一致性是耦合点**：`verify-skills.mjs` 的 R9 对账要求 Rust catalog 的 descriptor id 与 references preset 表 templateId 一致。U1（Rust 改 id）与 U3（references 改 id）必须协同落地——中间态（只改一边）会让 `build:worker` 的 verify:skills 报红。`scenario-config.ts` 持的是 ScenarioConfigId（场景不变），不参与 templateId 对账。

---

## System-Wide Impact

- **影响面**：拓扑 catalog 的可用模板从 3 降到 2；`describe_templates` 按场景只返回 `generic-tsn → [hop-linear]`、`aerospace-onboard → [hop-linear, dual-plane-redundant]`。
- **R9 耦合**：U1 与 U3 跨层一致才过 verify:skills——同一分支内协同落地，避免中间提交卡 CI/pre-commit。
- **旧会话**：存了 `generic-line`/`generic-ring` 的会话重新生成会收到清晰报错；既有拓扑图正常渲染/编辑（节点/连线与模板解耦）。

---

## Implementation Units

### U1. Rust：收口 catalog、参数、校验、builder

**Goal**：在 `topology_compute.rs` 删 `generic-ring`、把 `generic-line` 重命名为 `hop-linear` 并剥成 ends-only-only；清理参数合法域与校验；同步连带 Rust 文件与内联测试。

**Requirements**：R1、R2（origin）；KTD1/2/3/4。

**Dependencies**：无（首个单元）。

**Files**：
- `src-tauri/src/topology_compute.rs`（主）
- `src-tauri/src/topology_intermediate.rs`
- `src-tauri/src/topology_sidecar.rs`
- `src-tauri/src/topology_mutation_buffer.rs`

**Approach**：
- `all` catalog 列表（descriptor 清单）去掉 `generic_ring_descriptor()`，`generic_line_descriptor()` 改名 `hop_linear_descriptor()`、id 改 `"hop-linear"`。
- `generic_distributed_params`：删 `endSystemsPerSwitch` 项；descriptor 删 `endSystemPlacement` 枚举；只留 `switchCount` + `dataRateMbps`。
- 删常量 `END_SYSTEMS_PER_SWITCH_MIN/MAX`。
- 校验：templateId 白名单去掉 `generic-ring`、`generic-line` 改 `hop-linear`；删 `endSystemsPerSwitch` 合法域校验；删 `endSystemPlacement` / ends-only 分支（ends-only 成为唯一行为，无需开关）。
- builder：删 per-switch 分布式 builder 与 `generic-ring` 闭环布局分支；保留 ends-only builder 作为 `hop-linear` 的唯一生成路径，派发改名。
- 内联测试（`build_minimal_generic_line`、catalog 断言、ring 用例等）改名/改断言到新集合。
- 连带文件中对 `generic-line`/`generic-ring`/`endSystemsPerSwitch`/`endSystemPlacement` 的字符串/分支同步清理。

**Patterns to follow**：现有 descriptor/builder 的结构与 `dual_plane_descriptor` 并列；不引入新抽象（单路径）。

**Test scenarios**：
- catalog（无 scenario）恰好 = `["hop-linear", "dual-plane-redundant"]`。
- `describe_templates_catalog_filtered("generic-tsn")` = `[hop-linear]`；`("aerospace-onboard")` = `[hop-linear, dual-plane-redundant]`。
- initialize `templateId="generic-ring"` → `Unknown topology templateId` 错。
- initialize `templateId="generic-line"`（旧名）→ 未知 templateId 错（验证重命名彻底）。
- initialize `hop-linear` + `switchCount=N`（取 N=2 与 N=6）→ 生成线型、端系统只挂两端各 1 台。
- initialize 传入 `endSystemsPerSwitch` / `endSystemPlacement` → 被拒（未知参数，早失败）。
- dual-plane 单跳（1 组）与双跳（2 组）initialize 仍成功（回归，不变）。

**Verification**：`cargo test`（含改后内联测试）全绿；`cargo clippy -- -D warnings`、`cargo fmt --check` 绿；`grep` 在 `src-tauri/src/` 查不到 `generic-ring`、`generic-line`、`endSystemsPerSwitch`、`endSystemPlacement`。

---

### U2. MCP：input schema 去参数 / 去环形 / 改名

**Goal**：`topology-tools.ts` 的 `describe_templates` / `initialize` input schema 去掉 `endSystemsPerSwitch`、去掉环形，templateId 引用 `generic-line` → `hop-linear`；同步该层测试。

**Requirements**：R3、R6（origin）；KTD1/2。

**Dependencies**：U1（catalog/参数已是新形态）。

**Files**：
- `src-node/mcp/topology-tools.ts`
- `src-node/mcp/topology-tools.test.ts`

**Approach**：input schema（zod）删 `endSystemsPerSwitch` 字段；任何对 `generic-line`/`generic-ring` 的硬编码引用改成 `hop-linear` / 删除。测试里 `templateIds` 列表、`templateId: "generic-line"`、`endSystemsPerSwitch` 全部更新到新集合/新名/删除。

**Patterns to follow**：现有工具 handler 透传 sidecar 的结构；合法域以 sidecar describe_templates 为准（不在 MCP 重复合法域）。

**Test scenarios**：
- `describe_templates` 测试断言 templateIds = `["hop-linear", "dual-plane-redundant"]`。
- `initialize` 用 `hop-linear` + `switchCount` 转发到 sidecar、body 正确。
- input schema 不再接受/转发 `endSystemsPerSwitch`。
- 该文件 grep 不到 `generic-line`/`generic-ring`/`endSystemsPerSwitch`/`endSystemPlacement`。

**Verification**：`npx vitest run src-node/mcp/topology-tools.test.ts` 绿；`tsc`/`biome` 绿。

---

### U3. Skill references：重写 preset 表（R9 与 U1 协同）

**Goal**：`references/generic-tsn.md` 只留 `hop-linear` 行；`references/aerospace-onboard.md` 留双平面 + `hop-linear`、删环形 / 每交换机挂载 / `endSystemsPerSwitch` 措辞；按需同步 `SKILL.md`。

**Requirements**：R4、R5（origin）；KTD1/5。

**Dependencies**：U1（catalog 新 id；R9 要求两边一致——与 U1 同分支协同落地）。

**Files**：
- `.claude/skills/tsn-topology/references/generic-tsn.md`
- `.claude/skills/tsn-topology/references/aerospace-onboard.md`
- `.claude/skills/tsn-topology/SKILL.md`（若含模板路由/列表则同步）

**Approach**：references 的「按类型选模板」表 templateId 列改为 `hop-linear`（generic-tsn 仅此一行；aerospace 加上 `dual-plane-redundant`）；删环形行、per-switch 与 `endSystemsPerSwitch` 描述；SKILL.md 若提及这些模板/参数则一并改。改完跑 `npm run build:worker`（含 verify:skills）确认 R9 三方对账绿。

**Patterns to follow**：上一轮 references 已是「按类型选模板」表 + 指向 describe_templates 的 example；保持该结构。

**Test scenarios**：`Test expectation: none — 文档/指引改动`。校验改由 verify:skills（R9）承担。

**Verification**：`npm run build:worker` 成功、`verify:skills` 报 ok（R9：catalog ↔ references templateId 一致，无未知/缺行）。

---

### U4. 前端 skill 测试：更新 templateIds 列表

**Goal**：更新引用旧 catalog 的前端测试到新集合。

**Requirements**：R6（origin）。

**Dependencies**：U1（新 catalog）。

**Files**：
- `src/ui/skills/SkillFilePreview.test.tsx`
- `src/skills/skill-file-service.test.ts`

**Approach**：把测试里 `templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"]` 等 mock/断言改成 `["hop-linear", "dual-plane-redundant"]`；`generic-line` 引用改 `hop-linear`。前端非测试代码不涉及 templateId（已核实 `scenario-config.ts` 只持 flowTemplates）。

**Patterns to follow**：保持现有测试 mock 结构。

**Test scenarios**：
- 断言更新后的 templateIds 集合渲染/解析正确。
- 该两文件 grep 不到 `generic-line`/`generic-ring`。

**Verification**：`npx vitest run`（前端套件）绿；`tsc`/`biome` 绿。

---

## Verification（整体收口）

跨单元完成后一次性确认：
- `cargo test` 全绿；`npx vitest run` 全绿；`tsc --noEmit` / `biome check` / `cargo clippy -- -D warnings` / `cargo fmt --check` 全绿。
- `npm run build:worker` 成功、`verify:skills` ok（R9 绿）。
- 全仓（`src/` `src-node/` `src-tauri/src/` `.claude/`，排除 `dist/` `target/`）grep 不到 `endSystemsPerSwitch`、`endSystemPlacement`、`generic-ring`、`generic-line`。
- 手动（真机）：新会话「建个 N 跳线性」→ hop-linear 生成、ES 挂两端；「双平面单跳/双跳」仍正常；对旧 ring 会话点「重新生成」→ 清晰报错、既有图仍可看可编辑。

---

## Scope Boundaries

**Deferred to Follow-Up Work**
- 无（本计划覆盖 origin 全部 R1–R7）。

**Outside this change（不做）**
- 旧数据迁移 / 清理（KTD4：保持「旧拓扑只读可编辑、不可重生成」）。
- 抬高 `switchCount` 上限（保持 1–12）。
- `dual-plane-redundant` 模板内部逻辑 / 参数 / preset（KTD3）。
- 前端 `scenario-config.ts`（不持 templateId，已核实）。
- 时间同步 / 流量规划 / 配置下发等其它阶段。

---

## Open Questions

- 无（OQ1 已定 `hop-linear`）。执行期若发现 `SKILL.md` 实际未列模板，则 U3 中 SKILL.md 改动可省（以实查为准）。
