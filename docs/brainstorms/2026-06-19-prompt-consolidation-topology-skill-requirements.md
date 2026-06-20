---
date: 2026-06-19
topic: prompt-consolidation-topology-skill
origin: docs/ideation/2026-06-18-topology-confirmation-skill-ideation.md
---

# 理顺 agent 的 prompt 体系并重写拓扑 skill

## Summary

两条线一起做。**一、理文字**：定下「每类指令住哪一层」的归属规则，按它重写 SKILL.md 和 references、把 worker 骨架和 `buildPrompt` 里散落重叠的文案各归各位，让同一条规则有单一权威事实源，并清掉已知的几类矛盾；归属规则写进 AGENTS.md 防以后又散。**二、补兜底**：给「违反会破坏数据或误导用户」的高风险规则补上确定性兜底（脚本/MCP/Rust/app/前端），让换上偏弱的模型后也不靠它遵守文字就能守住意图。

## Problem Frame

现在 agent 的系统 prompt 是三段拼的（worker 骨架硬字符串 + SKILL.md + 场景 reference），但除此之外 `buildPrompt` 还在「用户轮」另塞了一大堆指令，职责跟系统 prompt 重叠。结果是同一条规则散在多处、措辞还各不一样。

最伤的是自相矛盾：worker 骨架里讲「重试复用同一 batch」时用的还是废弃键名 `imac`（PR #35 早改成 `sync_name` 了），而工具 description 用的是正确的 `syncName`——agent 同时读到两套，行为就飘。类似的还有「仿真没接入」散在 4 处措辞不一、「切回阶段」确认文案 3 层各写一遍、「initialize 后不复检 validate」写在 3 层。

规则散且不一致，agent 被互相打架的指令带偏，最终结果不稳定。这套理清是其它改进（场景确认前置、该问就问、破坏性确认、命名统一）能稳下来的地基——否则只是把乱摊子从一个文件挪到另一个文件。

还有一层更要紧：后续要把 Claude sonnet 换成**偏弱的模型**，弱模型不一定严格照 prompt 文字办。所以光把文字归到对的层还不够——凡是「靠请模型遵守」的关键规则，在弱模型下更容易跑偏、更容易幻觉。代码里其实已经有一套不靠模型的确定性骨架（按阶段的工具白名单、`validate` 结构闸、`确认并继续` 按钮的确定性推进、`sanitizeClaudeAssistantText` 输出守卫），这次顺势把「哪些规则该有确定性兜底、而不是只靠文字」一并理出来。

## Key Decisions

- **一次性全做，含动骨架。** 不分步、不只止血：归属规则 + 重写 SKILL/references + 合并骨架与 `buildPrompt` 散文案 + 清矛盾，一个周期做完。代价是动 worker 骨架（协议不变量）的风险集中在一次，靠关键流程验证（R11）兜底。

- **散文案按性质拆开分流，不整块搬。** `buildPrompt` 那堆按归属各回各家——协议的进骨架、领域指引进 SKILL、工具用法进对应 description——而不是整体挪到某一个文件。

- **防复发用人读指南，不做自动化守卫。** 归属规则写进 AGENTS.md 让人照着放，不引入 lint/test 这类自动检查。

- **理文字这条线不改语义。** R1-R11 是「搬家 + 去重 + 对齐措辞」，不趁机改任何规则的实际含义。会改行为的只有补兜底那条线（R12-R14，见下条），且改的是执行方式而非规则意图。

- **给弱模型补确定性兜底（本周期一并做）。** 每条规则除了「住哪层」，还要标它**靠什么生效**——纯靠文字（违反顶多措辞不佳），还是必须有确定性兜底（违反会破坏数据或误导用户）。后者在弱模型下不能只写在 prompt 里，得有脚本/MCP/Rust/app 层硬兜底。boss 定：R13 表里能补的兜底**都并入本周期**。其中有的只是把现有意图从「靠文字」变「代码强制」（apply 后自动 validate、initialize 后 validate 廉价返回、SW/ES 校验），有的是**新增门**（破坏性 dry-run 确认、引用不存在拦截、场景前端控件）——后者跟 ideation #6/#7/#2 的确定性核心重叠，并进来一起做；那几个 ideation 项更大的行为/UX 仍各自后续。

## Requirements

**归属规则与防复发指南**

- R1. 定义三层归属规则：协议不变量 → worker 骨架（不可编辑，用户改坏会破坏数据对账）；领域指引、措辞、参数默认 → SKILL.md 与 references/<场景id>.md（可编辑、注入生效）；单个工具怎么用 → 该 MCP 工具的 description。
- R2. 每条面向 agent 的规则有一处权威事实源，其它消费端引用或派生自它、不独立改写措辞。有些规则天然要在多个运行期表面露出（agent 指引、工具边界、UI），这时要的是「单一事实源」，不是物理上只剩一处。
- R3. 一条规则既是某工具用法、又像通用指引时，归到该工具的 description，不在骨架或 SKILL 再写一遍。
- R4. 把 R1-R3 写进 AGENTS.md 的一小节，作为以后新增或修改 prompt 时「放哪层」的判定依据。

**重写可编辑层**

- R5. 按归属规则重写 SKILL.md：场景路由、领域语义、初始化与编辑流程、澄清与验证规则各部分读得顺、不散、不与别处重复。
- R6. 重写 references/generic-tsn.md 与 references/aerospace-onboard.md，与 SKILL.md 职责不重叠。
- R7. 重写只调整文字的组织与归属，不改规则表达的实际语义（命名规则、协议不变量、参数默认值保持现状）。

**骨架与散文案归位**

- R8. 把 `buildPrompt` 的「用户轮」散文案（结构化结果规则、执行顺序、交互规则、回复要求）按性质拆开，分流到骨架 / SKILL / 对应工具 description。
- R9. worker 骨架只保留协议不变量；与可编辑层重复的内容从骨架移除。

**修掉已知矛盾**

- R10. 把下面这几类散落/矛盾的文案各收敛到单一住所：

| 散落的规则 | 现在散在哪 | 收敛到 |
|---|---|---|
| 重试逐字节复用同一 batch | 骨架 / buildPrompt / apply_operations description | apply_operations description |
| 节点身份键名 `imac` 残留 | 骨架 1 处（worker.mjs:451）+ buildPrompt 1 处（worker.mjs:598） | 全统一 `syncName` |
| initialize 后不复检 validate | 骨架 / SKILL / validate description | validate description |
| 显示名映射规则 | SKILL / inspect description | SKILL（领域语义）；description 只留该工具返回字段的用法 |
| verify 错误文案 | Rust 逐条错误文案 / TS `composeVerificationBlockText`（展示组合层）/ `inet_verify_command.rs`（INET 校验文案，第 3 处） | 正常分支 TS 已消费 Rust 逐条错误、不另写；`inet_unreachable` 分支是展示层语义合并（故意丢 suffix、加复检行），其单一源决策 defer 到规划 |
| 仿真/OMNeT++ 没接入 | 前 3 处是 prompt 文字（骨架 / buildPrompt / `buildConversationContext` 注入）；第 4 处「硬替换兜底」是运行时守卫 | prompt 文字收敛到单一源（骨架还是 SKILL 待规划定）；运行时守卫 `isUnsupportedSimulationClaim` + `sanitizeClaudeAssistantText` 不是 prompt、保留不动 |
| 「切回阶段」确认文案 | request_stage_change description / agent-adapter event / chat-pane UI（3 处，另需核对骨架是否也带一份） | 措辞对齐（不强求单一源）——event 是运行时模板串（插了 stageLabels/reason），抽不成与 description 共享的静态常量；规划时定 |

表里「本次定址」的是 ①②③④⑤；「待规划定址」的是 ⑥仿真、⑦切回，以及 ⑤的 `inet_unreachable` 分支——这几处要先读周边代码才能定，列在 OQ。另注：①重试复用、③initialize 后不复检 这两条，骨架注释（worker.mjs:446-450）已把它们声明为**有意置于骨架的协议不变量**；收敛时先定「骨架权威（删别处重复）vs description 权威（移出骨架）」，别默认搬去 description。

**改完验证不回退**

- R11. 以「agent 关键流程行为不回退」为完成前提。**动手前**先把选定的关键流程在 dev/真机各跑一遍、把每条的 agent 回复与工具调用序列存成基线；改完逐条跟基线比对，不凭记忆。最小流程清单（规划可再加）：① 从零初始化一张拓扑 ② apply_operations 增量编辑后 validate ③ 切阶段意图触发 request_stage_change ④ 重试场景复用同一 batch。SKILL.md 整体重写也纳入基线比对，不当作纯文字搬运豁免。

**确定性兜底（给弱模型）**

- R12. 这次给每条规则标 enforcement mode（随归属一起记进 AGENTS.md）：① 纯指引——违反顶多措辞/风格不佳，靠文字即可；② 文字 + 确定性兜底——违反会破坏数据或误导用户，必须有不经大模型的硬兜底；③ 纯确定性——根本不靠文字，直接代码强制。**有些规则的触发点本身要判用户意图（如「这是引用还是新建」），确定性层做不全——那部分老实标 ①/②，别因为「下放了脚本」就标成纯确定性自欺。**
- R13. 把「违反会破坏数据/误导用户、可当前只靠文字」的规则挑成清单。round-2 核过代码后，按「兜底有多确定、有多重」分三档（实现细节留规划）：

**A 档 · 真确定性、改动小（适合本周期先行）**

| 规则 | 现在靠 | 确定性兜底 |
|---|---|---|
| apply 后必做 validate | 文字 | app 每次 `apply_operations` 后自动跑 `validate` 并回报，不靠模型记得 |
| 命名 SW/ES 前缀（校验） | 文字 | `validate` 校前缀、挡不规范落库（`topology_verify.rs` 已派生 SW/ES 前缀，新增一条校验） |
| `initialize` 后不复检 validate | 文字 | `validate` 记「上次已校验的 mutationId」、无变更就廉价返回（mutationId 已有，需补 last-validated 持久态、处理 sidecar 重启清零） |

**B 档 · 写已幂等，「重发安全」已满足；「确定性重放」是另建**

| 规则 | 现状 |
|---|---|
| 重试复用同一 batch | `apply_op` 三态写入**已幂等**（`ON CONFLICT DO NOTHING`、同值 no-op/异值 `SYNC_NAME_TAKEN`）——模型重发同一 batch 已经安全。「app/MCP 不经模型自动重放上次 batch」当前不存在，要新建跨调用 batch 缓存+幂等 token，属协议层新增（补兜底线、与文字线分开 commit）；多数情况「重发安全」已够，重放未必要做 |

**C 档 · 仍需模型判意图，或是新建的重特性（规划逐项评估，可能拆出本周期）**

| 规则 | 为什么不是简单「下放脚本」 |
|---|---|
| 引用不存在不得擅自新建 | **非纯确定性**。`node_add` 是盲 INSERT，op 不带「引用还是新建」信号——用户的「连到 SW3」在到 MCP 前已被模型解析成具体 syncName。确定性能拦的只有「`link_add` 端点指向不存在节点 → 拒绝/`requires_clarification`」这一半；「该引用还是新建」仍靠模型，enforcement mode 标 ① |
| 破坏冗余/删除先确认 | **新建重特性**。`dry_run` 现仅结构校验预览、无 `destructive` 概念（全仓零冗余/降级判定）；要确定性判「删这条把双归属打成单点」需新建图论分析，再加操作级 pending-confirm 门（现仅阶段级确认按钮）。与 A 档接线不同量级，跟 ideation #6 同核心 |
| node_add 直接分配名字 | **新增能力 + 需授权**。`NodeAdd` op 当前无 name 字段（仅 `initialize` 写 name），要新增 op 字段+schema+序号规则；ideation #7 原就标「得你点头」；且 syncName 仍模型挑、名字正确性仍受影响。（A 档的「validate 校前缀」是独立的、可先行） |
| 场景前端控件 | **新 UI + 状态写入**。要新控件 + 选定后把 `scenarioConfigId` 写入会话（可能要新 Tauri 命令）。最小完成定义未定，跟 ideation #2 同核心 |

已有 ✓ 的（`sanitizeClaudeAssistantText` 仿真守卫、按阶段工具白名单、确认按钮确定性推进）保留不动，文字副本可相应减少。

- R14. boss 定「能补的都补」，但 round-2 核查改了执行姿态：**A 档本周期做**（便宜、纯确定性）；**B 档**只确认「重发安全」已满足、确定性重放按需而非必做；**C 档逐项评估**——可行就做，判不可行/超预算就退回靠文字 + defer 并记 AGENTS.md 待办，**不阻塞 A 档与文字线收口**（即「都有结论」而非「都落地」）。其中 `node_add` 加 name 字段、破坏性确认门这两项动 schema/属新特性，实现策略规划前需 boss 再确认。

- R15. 每个新增确定性门除了 R11 的回退基线，还要各带：正例（绕过文字指引也守得住）+ 负例（不误拦合法操作——合法历史命名不被前缀校验挡、非破坏删除不被 dry-run 阻断、稳定态重复 validate 不误报）。R11 的 4 条 happy-path 基线是为文字线设计的，证伪不了新门的假阳性。

## Scope Boundaries

- 理文字那条线（R1-R11）不改规则的**实际语义**，只搬家+去重+对齐措辞。补兜底那条线（R12-R14）会改行为，但改的是「执行方式」（从靠模型遵守文字 → 代码强制同一意图），并按需新增确定性门。
- #2/#6/#7 的**确定性兜底核心**（场景前端控件、破坏性 dry-run 确认、SW/ES 校验）按 R13 纳入本周期（C 档逐项评估）；但这三项**更大的行为/UX**——完整场景画像回执与中途切场景（#2）、破坏性分级/状态机（#6）、node_add 序号规则完整化（#7）——仍各自后续。
- 整个**不在这次**：validate 当用户可问的可行性检查（#3）、模板按 id 取（#4）、该问就问里超出「引用不存在」的澄清（歧义/模糊目标，#5 其余）、推理态 UI（#8）。
- 防复发只做 AGENTS.md 里的人读指南，不做自动化 lint/test 守卫。
- prompt 的底层注入机制（三段拼接、`<<<SKILL_GUIDANCE>>>` / `<<<SCENARIO_REFERENCE>>>` 哨兵、字符串拼接）不动，这次只搬内容不改架构。
- `agent-adapter` 里 `buildConversationContext` 每轮注入的规则串**算 prompt 文字**，纳入本次去重；但运行时守卫（`isUnsupportedSimulationClaim` + `sanitizeClaudeAssistantText` 这类不经大模型的硬替换/拦截）**不是 prompt**，不在归位范围、保留不动。

## Success Criteria

- 每条面向 agent 的规则有单一权威事实源、他处不独立改写——抽查 R10 那 7 类，本次定址的确认已收敛，留规划的已在规划文档定址。
- worker 骨架再无 `imac` 残留，节点身份键名全是 `syncName`。
- 翻 AGENTS.md 能查到「新规则放哪层」，并据此放得下一条新规则。
- 每条规则都标了 enforcement mode；「会破坏数据/误导用户、却只靠文字」的高风险规则没有被漏掉。
- A 档兜底都落地，且每个新门都过了正例（绕过文字也守得住）+ 负例（不误拦合法操作）；C 档每项有结论（落地，或带理由 defer 回文字 + 记 AGENTS.md），不以「纯确定性」之名实际仍靠模型蒙混过关。
- 选定的关键流程在 dev/真机行为与改前一致，没有因为搬文案而回退。

## Dependencies / Assumptions

- 改 worker prompt 后必须 `build:worker`（worker 跑 dist 产物），否则改动对 agent 不生效。
- 指引注入用字符串拼接、不能传数组（`string[]` 会让 `redactSecrets` 抛错）。
- `AskUserQuestion` 工具全局禁用——需要用户决策的指引只能让 agent 在对话里出中文编号选项，或做成前端控件，不能指望那个工具。
- 「确认并继续」按钮保留确定性推进（不走大模型）。
- 安全与正确性判断不靠 prompt——这正是协议不变量留在骨架、不进可编辑层的根本原因。

## Outstanding Questions

**Deferred to Planning**（规划或读码时定，不卡当前规划启动）

- A 档兜底与文字线的实现顺序、是否分阶段（A 档必做；C 档每项规划核可行性后决定做或 defer，见 R14）。

- 「仿真/OMNeT++ 没接入」最终的单一住所是骨架还是 SKILL——取决于它算不算协议不变量。
- 「切回阶段」3 处文案怎么收敛：抽一个共享常量让三处引用，还是各留但对齐措辞（UI 渲染、agent 指引、运行时生成是三个不同消费端，未必能删到只剩一处）。
- `inspect` description 里那段领域语义逐条判定：哪些（如 syncName 身份）移进 SKILL，哪些（如 stylesJson 的 plane/role 是该工具返回字段的用法）留在 description。
- `buildPrompt` 的回复要求 7 条逐条归属（哪几条是协议、哪几条是领域指引）。
- R11 的关键流程验证清单具体包含哪些 flow。
