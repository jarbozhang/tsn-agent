---
date: 2026-06-12
topic: scenario-skill-split
status: ready-for-planning
origin: docs/ideation/2026-06-11-scenario-skill-split-ideation.html
---

# 场景体系 + skill 按场景拆分 + 5 跳线性拓扑

## Problem / Context

拓扑能力要按业务场景组织：保持「通用 TSN + 宇航」两场景、场景下挂多种拓扑结构、预留工业场景。当前三处脱节：①场景（`src/domain/scenario-config.ts`）与模板 catalog 无机器可读关联，映射靠 87 行 SKILL.md 决策树散文，且决策树只按用户措辞分支、从不消费场景 id（选了宇航场景 agent 行为不变）；②规范图 5-1 的五跳线性（E1→SW1..SW5→E2，端系统仅两端，S 形折叠）现有模板表达不了；③skill 单文件承载全部指引，按官方 Agent Skills Pattern 2 应拆为主索引 + per-scenario reference，但**播种是目录粒度「已存在即跳过」（`skill_files.rs` R4）——不升级播种，拆分新增的文件对所有存量安装静默不达**。

关键前提校正（ideation 三个子代理交叉核实）：`scenarioConfigId` 已经送达 worker 的 `buildSystemPromptForStage`（经 `agent-adapter.ts` → spawn payload → worker，当前形参 `_stageRunnerInput` 弃用）——「按场景确定性注入」可行。

---

## Key Decisions

- **播种升级是发布前置**，不是优化：manifest 哈希三态（dpkg conffile 先例）同时解决「新文件送达」与「未编辑文件内容升级」。**首次升级悖论的解法 = 新二进制内嵌历代出厂哈希清单**（dpkg 旧 md5sums 的完整对应物）：存量安装无 manifest 时，现存文件哈希命中任一历代出厂值即判「未编辑」、允许静默更新——没有这一条，三态对本次发布针对的全部存量用户恰好不成立（评审实证）。「恢复内置版本」按钮是免费副产品，本期一并交付。
- **注入策略 = worker 按场景确定性拼接**（非全量、非纯靠 agent 自觉 Read）：活跃场景指引确定在场、非活跃场景零 token；注入正文带 references 绝对路径表供 agent 跨场景按需 Read（堵 PR#21 休眠病复发：references 默认不在注入路径上，release 下相对路径 Read 会读到工厂副本）。
- **内容三层判据**（QRH memory-item vs read-do）：用户改坏会破坏 worker 对账的协议不变量上移代码骨架（不再可热编辑）；主 SKILL.md = 开工前必知 + 场景路由；reference = 定场景后才消费。
- **5 跳线性走参数化不开新模板**（遵循既有 Rejection #1）：generic-line 加 `endSystemPlacement`；蛇形折叠是 generic-line 专属确定性公式，ring 与 per-switch 布局完全不动。
- **场景语义放 reference（可编辑文档），结构归 catalog**：descriptor 挂 `scenarios` 标签（三模板归属全量定死，含 generic-ring 双场景——现行「航天双环冗余→ring」路由保留），reference 承载机器可读锚点格式的命名 preset 表（CVD 式），verify-skills 对账防漂移；工业预留 = 「reference 文件名 == ScenarioConfigId」命名契约，本期零占位文件、零代码。
- **本轮显式反转既有 Rejection #4（不拆 reference）**：新论据 = 官方 Pattern 2 背书 + 场景扩展预期（Phase B 各阶段指引都将按场景承载）。
- 全量恢复保留（不做按文件恢复），但确认步骤枚举将被覆盖的已编辑文件清单——知情代价。

---

## Requirements

**播种与升级**

- R1. 播种从目录粒度升级为文件粒度三态：播种时写出厂 manifest（文件 → 出厂内容哈希，**落点在 skill 目录之外**，不进面板文件列表）；此后每次解析逐文件判定——app-data 缺失 → 补播；存在且哈希命中**当前或任一历代出厂值** → 随新版本静默更新；其余（用户改过）→ 保留。新二进制内嵌历代出厂哈希清单（至少含上一发布版全部出厂文件），manifest 缺失（存量首个升级）时按历代哈希判定「未编辑」；判定不出的现存文件保守保留且**不登记伪造哈希**（manifest 条目不变量：只允许登记真实出厂版本的哈希，未知态显式标记）。
- R1a. 出厂移除清单：随播种/恢复删除「新出厂清单已移除、且内容哈希命中历代出厂值」的孤儿文件（本期仅 `package.json`）；用户改过的孤儿保留。
- R2. Skill 面板新增「恢复内置版本」入口（二次确认，确认时**枚举将被覆盖的已编辑文件清单**）；恢复 = 按当前出厂 manifest 重写全部出厂文件 + 执行 R1a 移除清单，下次 agent 运行生效，面板即时刷新。

**skill 结构与注入**

- R3. skill 目录重组：`SKILL.md`（主索引）+ `references/generic-tsn.md` + `references/aerospace-onboard.md`；删除 `package.json`（规范外残留）。工业预留 = 命名契约（`references/<ScenarioConfigId>.md`），本期不建占位文件。
- R4. 内容三层归位：协议不变量逐条迁移进 worker `SYSTEM_PROMPT_SKELETON`（迁移时逐条确认「协议 vs 可调指引」，错划会把该让用户调的锁死）；主 SKILL.md 留领域语义表、回复边界、场景路由表；reference 留该场景模板选择、推荐参数默认、规范图 preset 表。reference 不复述参数合法域（合法域仍以 describe_templates 为准）。每个 skill 文件头部以注释说明其消费方式（每次运行注入 / 按场景注入 / agent 按需读取——纯文档，零代码）。
- R5. worker 按 `scenarioConfigId` 注入「主索引 + 当前场景 reference」（仍为单字符串 + sentinel 契约）+ 运行时枚举的 references 绝对路径表；未知/缺失场景回退 `generic-tsn` reference。降级分两层互不复合：播种层失败（R1 判定）只影响文件内容新旧；注入层失败（场景文件读不到）fail-open 为仅注入索引 + 审计警告。reference 指引 agent：用户请求超出当前场景模板集时，先去掉 scenario 过滤重查全量再答复。

**场景→模板映射**

- R7. 模板 descriptor 增加 `scenarios` 字段，三模板归属全量定死：generic-line = [通用, 宇航]、generic-ring = [通用, 宇航]（保留现行「航天双环冗余」路由）、dual-plane-redundant = [宇航]；`describe_templates` 返回携带，并增加可选 `scenario` 过滤参数——传入只返回该场景模板（候选集与注入指引同场景闭环），不传返回全量（向后兼容）。既有 `tags` 形态标签在结果中保留作类别维度，不另设第二过滤参数。
- R8. reference 内命名 preset 表，**机器可读锚点格式**（固定列序 markdown 表，templateId 以行内反引号代码字段为 lint 唯一识别依据）：「规范图号/别名 → `templateId` + 完整参数 JSON + 布局说明」。宇航必含：图 4-1 双平面单跳、图 4-5 双平面双跳、图 5-1 五跳线性、环网一行（承载 ring 的宇航归属）；通用 reference 含场景说明、模板路由与推荐默认（preset JSON 可选）。删除 `defaults.topology` 后（R14），场景级拓扑参数建议值由 reference 单源承载。
- R9. `verify-skills` 对账分两层：（核心）场景 reference 文件名必须等于已注册 ScenarioConfigId；（对账）reference preset 表引用的 `templateId` 必须存在于 catalog、声明了场景的模板必须在该场景 reference 的 preset 表中至少有一行——「承载」判据即 R8 的格式锚点。

**5 跳线性拓扑**

- R10. generic-line 增加 `endSystemPlacement: "per-switch" | "ends-only"`（缺省 per-switch，全向后兼容，`endSystemsPerSwitch` 含义不变）；ends-only 模式 = 端系统仅挂链两端、每端 1 个（图 5-1 形态），该模式下 `endSystemsPerSwitch` 必须为 1（其余值返回参数校验错误，不做语义重载）。
- R11. 蛇形折叠为 **generic-line 专属、仅 ends-only 模式**的布局分支：switchCount ≥ 5 时按确定性公式折叠（行向交替 + U 弯换行 + 行距沿用既有量级；公式天然自适应更多行，验收锚定 5 跳两行）。per-switch 模式、generic-ring、既有会话坐标完全不受影响。验收对图不对文（对照规范图 5-1 转出的图像本体）。
- R12. 新参数全链路一致与确定性验收：descriptor / MCP zod / Rust 校验三处合法域一致（沿用既有 drift 守护）；同参两次生成坐标全等、无坐标重叠、折返链路不穿任何节点框；端口分配兼容 ends-only（打破均匀挂载前提）。具体实施关卡由规划文档展开。

**打包与清理**

- R13. tauri.conf 资源从逐文件映射改为 skills 整目录映射（落地前核实 Tauri 2 目录资源递归语义；若语义不符则回退逐文件映射并接受同步成本，AE6 第一子句随之调整为「补一行映射后闸绿」）；`verify-skills` 职责反转：目录映射存在 + 文件 git 跟踪 + 正向白名单（skill 目录只允许 SKILL.md 与 references/*.md 文本文件）；`commands.rs` 打包断言同步改写（含「package.json 不得存在」反向断言）。
- R14. 删除 `scenario-config.ts` 的 `defaults.topology` 死配置（零消费、与 SKILL 推荐值已漂移；已确认授权）；拓扑参数建议值此后由场景 reference 单源（见 R8）。

---

## Acceptance Examples

- AE1. **升级送达（三态各一例）。** Given 模拟旧版 app-data（含用户改过一行的旧单体 SKILL.md、未编辑的旧出厂 `tsn-flow-planning/SKILL.md`、旧出厂 package.json，无 manifest），When 升级新版后首次启动，Then `references/` 两场景文件被补播（缺失补播）、未编辑的旧出厂文件哈希命中历代出厂值而随新版更新（静默更新）、用户改过的 SKILL.md 内容保留（编辑保留）、package.json 按移除清单被删除。**Covers R1, R1a.**
- AE2. **按场景注入。** Given 宇航场景会话，When agent 运行，Then 审计的 systemPrompt 含宇航 reference 内容、不含通用 reference 内容；通用场景会话反之；任一会话的注入正文含 references 绝对路径表。**Covers R5.**
- AE3. **五跳生成。** Given `generic-line, switchCount=5, endSystemPlacement=ends-only, endSystemsPerSwitch=1`，When initialize，Then 落库 7 节点（5 SW + 2 ES）6 链路（SW 级联 4 条 + 两端 ES 各 1 条）、ES 仅在链两端、画布呈两行 S 形折叠（与规范图 5-1 坐标快照一致）、同参两次坐标全等且无重叠、折返链路不穿任何节点框；`endSystemsPerSwitch=2` 时返回参数校验错误。**Covers R10, R11, R12.**
- AE4. **preset 命中与场景过滤。** Given 宇航场景，When 用户说「按规范图 5-1 搭」，Then agent 经 reference preset 表一次 initialize 成功，参数与表中 JSON 逐字段一致（无追问往返——属真机人工验收口径，模型遵循度非自动化门槛）；When agent 调 `describe_templates({scenario:"aerospace-onboard"})`，Then 返回 generic-line / generic-ring / dual-plane-redundant 三模板、不传参数时返回全量。**Covers R7, R8.**
- AE5. **恢复内置。** Given 用户编辑过 SKILL.md 与宇航 reference，When 点击「恢复内置版本」，Then 确认步骤列出这两个将被覆盖的文件，确认后全部出厂文件回到出厂内容、面板即时刷新、下次运行注入出厂指引。**Covers R2.**
- AE6. **打包闸。** Given 新增 `references/industrial.md` 而不改任何打包配置（目录映射主路径），When 跑 verify-skills 与打包，Then 闸绿且包内含该文件；Given 往 skill 目录放一个 `.js` 或残留 package.json 映射，Then 闸红。**Covers R3, R9, R13.**

---

## Scope Boundaries

- **缓一期**：规范图 fixture 黄金测试管线（三套典型组网配置变表驱动 fixture——5 跳线性本期自带坐标快照与防穿框断言）；Skill 面板的消费方式 UI 标注（本期以文件头注释承载，见 R4）；按文件粒度恢复（本期全量恢复 + 知情清单）。
- **不做**：工业场景 reference 内容与 ScenarioConfigId 注册（预留即命名契约本身）；其他 skill（tsn-time-sync 等）的拆分（Phase B 各阶段落地时按本契约克隆）；preset 表进 Rust catalog（场景语义保持可编辑文档承载，错参由既有参数校验兜底）；`SKILL_IDS` 幽灵清理（id-only 预留是既有模式，保留）；generic-ring 折叠布局（ring 超宽单行维持现状，后续独立增量）。
- **接受的降级**：存量用户**改过**旧单体 SKILL.md 时，注入为「保留的旧版正文 + 新场景 reference」并存——内容冗余但旧单体自包含无害，重置按钮是自助收敛通道（未编辑用户经 R1 历代哈希正常升级，不落入此态）；审计记录 skillRoot 原始路径（排查需要）。

---

## Dependencies / Assumptions

- Tauri 2 `bundle.resources` 目录映射的递归语义需在规划前核实（R13 唯一外部不确定点，已给回退路径与 AE6 条款调整）。
- `scenarioConfigId` 全链路送达 worker 已核实（`agent-adapter.ts` → payload → `buildSystemPromptForStage` 首参）。
- 注入为单字符串 + `<<<SKILL_GUIDANCE>>>` sentinel 是硬约束（string[] 会崩 redactSecrets，实证回退过）；多文件拼接仍须落单字符串；redactSecrets 不触碰绝对路径（已核实，路径表相容）。
- skillRoot 三级解析与 app-data 可写副本机制已于 2026-06-11 落地（本特性在其上叠加文件粒度语义）。debug 构建命中仓库根时跳过播种——恢复按钮在 dev / Resource 只读兜底态的禁用或降级行为由规划定义。
- 历代出厂哈希清单的生成方式（从 git release tag 提取出厂文件内容哈希、编译期内嵌）由规划定义；R9 对账 lint 读取 catalog 的方式（解析 Rust 源 / 共享 JSON / vitest 层）由规划选定。

---

## Outstanding Questions

无阻塞项。蛇形折叠行距常量的最终取值在规划/实现期按「对图不对文」校准。
