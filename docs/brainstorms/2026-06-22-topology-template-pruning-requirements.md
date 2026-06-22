# 拓扑模板裁剪：移除每交换机挂载 / 环形，收成双平面 + 跳线性

- 日期：2026-06-22
- 状态：需求已确认，待 ce-plan
- 范围：Standard（跨 skill→rust→mcp→前端→db 的删除 + 重构，方案已定）

## Summary

把拓扑模型从「线型（双模式）/ 环形 / 双平面」收成**两个**模板：
- `dual-plane-redundant`（不变）—— 1 个 switchGroup = 双平面单跳，2 个 group = 双平面双跳。
- `hop-linear`（由 `generic-line` 重命名而来，剥到只剩 ends-only）—— 任意 `switchCount`、端系统只挂链路两端，通用与宇航两场景共用。

删除「每交换机挂载」线型、环形冗余，以及 `endSystemsPerSwitch` / `endSystemPlacement` 参数及其合法域，贯穿 skill、Rust、MCP、前端、数据库。双平面模板用显式 `endSystems`/`attachment`、不使用 `endSystemsPerSwitch`，故本次删除**不触及双平面**。

## Context

当前 `topology_compute.rs` 有三个 descriptor：`generic-line`（含 `per-switch` 与 `ends-only` 两种挂载模式）、`generic-ring`、`dual-plane-redundant`。「跳线性」实际就是 `generic-line` 的 `ends-only` 模式；要删的「每交换机挂载」是同一模板的 `per-switch` 模式。删掉 per-switch 后，`generic-line` 只剩一种模式，`endSystemPlacement` 这个二选一枚举随之失去意义。

## Key Decisions

- **D1 跳线性参数模型**：`hop-linear` 只收 `switchCount`（合法域 1–12 不变）+ `dataRateMbps`，端系统固定挂链路两端。删除 `endSystemsPerSwitch`、`endSystemPlacement`、`END_SYSTEMS_PER_SWITCH_MIN/MAX`，以及对应的 ends-only/per-switch 校验分支。
- **D2 双平面单跳/双跳**：保持同一个 `dual-plane-redundant` 模板，按 switchGroup 数区分单/双跳，不拆成命名模板。模板内部不动。
- **D3 跳线性模板归属**：通用与宇航**共用一份**跳线性模板，并将 templateId 由 `generic-line` **重命名为 `hop-linear`**。两个场景（`generic-tsn`、`aerospace-onboard`）的 reference 都指向它。
- **D4 旧数据处理**：不写迁移。库里已有的 ring / per-switch 拓扑仍可显示与编辑（它们落库后只是节点/连线行、与模板无关）；用已删除的 templateId 重新 initialize 会报错，且该硬报错可接受。

## 最终模板集合（目标态）

| templateId | 场景 | 参数 |
|---|---|---|
| `dual-plane-redundant` | `aerospace-onboard` | 显式 planes/switches/switchGroups/endSystems/attachment/backbone/crossPlaneLinks + dataRateMbps（不变；单跳=1 组、双跳=2 组） |
| `hop-linear` | `generic-tsn`、`aerospace-onboard` | `switchCount`(1–12) + `dataRateMbps`，端系统挂两端 |
| ~~`generic-ring`~~ | — | 完整删除 |
| ~~`generic-line` per-switch 模式~~ | — | 删除（模板本体重命名+剥成 `hop-linear`） |

## Requirements

- **R1**（Rust）`topology_compute.rs`：删除 `generic_ring_descriptor` 及环形 builder；删除 `END_SYSTEMS_PER_SWITCH_MIN/MAX` 常量与 `endSystemsPerSwitch` 合法域校验；删除 `endSystemPlacement` 枚举与 per-switch/ends-only 分支校验；删除 per-switch 分布式 builder（保留 ends-only builder）；将 `generic-line` descriptor 重命名为 `hop-linear` 并剥成只接 `switchCount`+`dataRateMbps`。
- **R2**（Rust 连带）`topology_intermediate.rs`、`topology_sidecar.rs`、`topology_mutation_buffer.rs` 中对 `generic-line`/`generic-ring`/`endSystemsPerSwitch`/`endSystemPlacement` 的引用同步清理/改名。
- **R3**（MCP）`src-node/mcp/topology-tools.ts`：`describe_templates`/`initialize` 的 input schema 去掉 `endSystemsPerSwitch`、去掉环形相关，templateId `generic-line`→`hop-linear`。
- **R4**（Skill）`references/generic-tsn.md` 只保留 hop-linear 行；`references/aerospace-onboard.md` 保留双平面（单/双跳）与 hop-linear 行，删去环形、每交换机挂载、`endSystemsPerSwitch` 措辞；按需同步 `SKILL.md`。
- **R5**（对账）`scripts/verify-skills.mjs` 的 R9 三方对账（Rust catalog ↔ `src/domain/scenario-config.ts` ↔ references）三处 templateId 必须一致：`generic-ring` 移除、`generic-line`→`hop-linear`。
- **R6**（测试）更新 `src-node/mcp/topology-tools.test.ts`、`src/ui/skills/SkillFilePreview.test.tsx`、`src/skills/skill-file-service.test.ts` 及 Rust 内联测试中对 ring/line/`endSystemsPerSwitch` 的引用。
- **R7**（前端）核查并更新任何前端对这些 templateId / 参数的引用（scenario-config 当前用的是 flowTemplates，疑似不受影响——以实查为准）。

## Scope Boundaries

**Deferred / 不做**
- 旧数据迁移或清理（D4）——保持「旧拓扑只读可编辑、不可重生成」。
- 抬高 `switchCount` 上限——保持 1–12；真要 >12 跳的线另开。

**不触及**
- `dual-plane-redundant` 模板的内部生成逻辑、参数结构、preset（D2）。
- 时间同步 / 流量规划 / 配置下发等其它阶段。

## Dependencies / Assumptions

- 假设前端 `scenario-config.ts` 不直接引用拓扑 templateId（只持有 flowTemplates）——ce-plan 阶段需实查确认。
- 假设新 templateId 取名 `hop-linear`（见 Outstanding）。
- 改 worker/skill 后须 `npm run build:worker`（含 verify:skills）；改 Rust 后 `cargo test`；全程过 biome / tsc / clippy / cargo fmt。

## Success Criteria

- catalog 只剩 `dual-plane-redundant` + `hop-linear`；`describe_templates` 按场景只返回这两类。
- 全仓（代码 / skill / 测试，排除 dist/target）grep 不到 `endSystemsPerSwitch`、`endSystemPlacement`、`generic-ring`、`generic-line`。
- `verify-skills` R9 绿；vitest / cargo test 全绿；tsc / biome / clippy / cargo fmt 绿。
- 旧拓扑仍能正常显示与编辑；用已删 templateId 重新 initialize 收到清晰报错。

## Outstanding Questions

- **OQ1** 新 templateId 确定为 `hop-linear` 还是 `linear`？（本文档按 `hop-linear`，ce-plan 起始可一句话定。）
