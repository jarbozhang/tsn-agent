---
title: "feat: 场景体系 + skill 按场景拆分 + 5 跳线性拓扑"
type: feat
status: active
date: 2026-06-12
origin: docs/brainstorms/2026-06-12-scenario-skill-split-requirements.md
---

# feat: 场景体系 + skill 按场景拆分 + 5 跳线性拓扑

## Summary

七个实施单元交付需求文档 R1-R14：播种升级为文件粒度三态（manifest + 历代出厂哈希，发布前置）+ 「恢复内置版本」入口；skill 拆为主索引 + 双场景 reference（协议不变量上移 worker 骨架，删 package.json）；worker 按场景确定性注入；catalog 挂 scenarios 标签 + describe_templates 场景过滤；generic-line 加 ends-only 参数 + 蛇形折叠布局；打包链路换目录映射 + 白名单 + 三方对账。基于 `feat/release-writable-skill` 分支（叠加其 skillRoot 三级解析与播种机制）。

---

## Problem Frame

见 origin 需求文档 Problem/Context。一句话：场景与模板无机器关联、规范图 5-1 表达不了、skill 拆分会被目录粒度播种吞掉——三件事捆绑成一期，播种升级是其余一切对存量用户生效的前置。

---

## Requirements

R1/R1a/R2（播种三态 + 移除清单 + 恢复入口）、R3/R4/R5（目录重组 + 三层归位 + 场景注入）、R7/R8/R9（scenarios 字段 + preset 表 + 对账）、R10/R11/R12（ends-only + 蛇形 + 全链路一致）、R13/R14（目录映射 + 删死配置）——全部承接 origin，无新增行为。

---

## Key Technical Decisions

- **KTD1 历代出厂哈希 = 手工维护常量表**（`skill_factory_hashes.rs`），锚定判据是「**上一个执行过播种的构建**」而非「上一发布版」——v0.4.1 无播种机制、野外无 app-data 副本（评审实证）；唯一真实的旧出厂 app-data 来自 release-writable 构建（验收机 + 潜在中间版用户），其播种内容 = 该分支三个出厂文件（SKILL.md sha256 6daa182b…）。本期表内容 = release-writable 播种内容哈希 + v0.4.1 出厂文件哈希（无害冗余超集，发布序列无论如何都安全），注释来源 commit。后续发版把「追加本版出厂哈希」写入发版 checklist。不做 build.rs git 提取。
- **KTD2 manifest 落点 `app-data/skills/.factory-manifest.json`**——在 skills 根下但不在任何 per-skill 目录内，`collect_skill_files` 按 skill 目录递归枚举，天然不进面板列表（已对照代码核实）；JSON 结构 `{version, files: {相对路径: sha256}, modified: [相对路径]}`——files 表只存真实出厂哈希（不变量），用户改过的文件进 modified 数组，不存伪哈希。manifest 写入沿用 tmp+rename 原子写。
- **KTD3 恢复入口 = 单 command 双模式**：`restore_factory_skills(dryRun)`——dry-run 返回「将被覆盖的已编辑文件 + 将被删除的孤儿文件」清单供确认 UI 枚举；实跑执行重写 + R1a 移除。不拆两个 command（清单与执行共享同一判定逻辑，拆开会漂移）。
- **KTD4 worker 场景注入实现在 `buildSystemPromptForStage` 内**：从 `stageRunnerInput.scenarioConfigId` 取场景（弃用下划线参数转正），注入 = 索引 + `references/<scenario>.md`（缺失/未知回退 `generic-tsn.md`，再缺失只注索引）+ 运行时枚举 `references/*.md` 绝对路径表；全程单字符串 + sentinel。索引与 reference 之间用第二 sentinel（`<<<SCENARIO_REFERENCE>>>`) 分隔便于测试断言与审计切分。
- **KTD5 蛇形折叠是 generic-line 生成器内的独立布局分支**（templateId + ends-only 双守卫，不碰共用路径）：行容量 = ceil(switchCount/2) 起步的确定性公式（5 跳 → 3+2 两行对齐图 5-1），行距沿用 200 量级、x 步距沿用 300；折返 U 弯为两段正交；ES 在两端外伸（沿用 SIDE_GAP 量级）。常量最终值由「对图不对文」校准（实现期对照 5-1 png）。
- **KTD6 目录映射两级回退**：首选 `"../.claude/skills/": ".claude/skills/"` 整目录条目（官方 map 形式支持目录 key）；构建实测若子目录结构被拍平（官方警告 glob 不保留结构，目录 key 行为需实证）→ 回退 per-skill-dir 映射（每 skill 一行）；再不符 → per-file 并调整 AE6 口径。verify-skills 的白名单与对账逻辑与映射形式解耦（独立校验，不依赖映射粒度）。
- **KTD7 R9 对账 lint 读 catalog 的方式 = 正则解析 Rust 源，锚点防过匹配**：模板 id 全集取 `describe_templates_catalog` 的 `"templateIds": [...]` 单行数组（评审实证：dual-plane descriptor 的 example/itemShape 内嵌十余个伪 `"id"` 键，裸 id 锚点会静默放绿）；场景归属按 descriptor 函数块切分提取 `"scenarios"` 并与 templateIds 全集配对；lint 内硬断言提取数量与 drift 测试模板清单一致（不匹配即红——把静默放绿转回响亮失败）。零新依赖。preset 表锚点 = markdown 表中行内反引号 `` `templateId` `` 字段。
- **KTD8 协议不变量迁移清单（R4）在 U3 内逐条注释裁决**：现 SKILL.md 中「不要写 stage-result、必走 MCP、阶段顺序、重试逐字节复用、不复检 validate」等属协议（上移骨架）；「推荐默认值、决策树、术语表、回复风格」属可调指引（留 skill 文件）。每条迁移在 commit message 中可追溯。

---

## Implementation Units

### U1. 播种文件粒度三态 + 历代哈希 + 移除清单（Rust）

- **Goal**: 存量与新装安装都能收到新增/更新的出厂文件，用户编辑永不被覆盖（R1/R1a）。
- **Requirements**: R1, R1a
- **Dependencies**: 无（基于 feat/release-writable-skill 的 ensure_seeded）
- **Files**:
  - 修改 `src-tauri/src/skill_files.rs`（ensure_seeded 重写为文件粒度三态；manifest 读写；移除清单）
  - 新建 `src-tauri/src/skill_factory_hashes.rs`（历代出厂哈希常量 + 出厂移除清单）
- **Approach**: 逐文件**三分支**判定——dst 缺失 → 复制并登记；dst 哈希 == 当前出厂 → **仅登记 manifest，不重写文件**（评审抓出：无条件重写会在每次解析时与 write_skill_file 竞态、可静默盖掉用户刚保存的编辑）；dst 哈希 ∈ 历代出厂且 ≠ 当前 → 覆盖更新并登记；其余 → 保留并进 modified 数组。R1a：对「移除清单 ∩ 哈希命中历代出厂」的孤儿执行删除。manifest 缺失 = 全部按历代哈希判定（存量首升路径）。**三态判定核心函数把历代哈希表参数化注入**（生产入口绑常量表，测试注入 fixture 自算哈希——对齐 resolve_effective_root 候选注入模式；AE1 夹具的旧出厂内容从 pinned commit `git show` 提取真实文件，禁止自造哈希）。sha256 用 `sha2` crate——已核实 Cargo.lock 含 sha2 0.10.9（tauri 链传递依赖），Cargo.toml 声明同 minor 版本不引入新构建图条目。
- **Patterns to follow**: 既有 seed_skill_dir 的 tmp+rename / symlink 跳过 / 并发输家复查；timestamp/原子写惯例。
- **Test scenarios**:
  - Covers AE1：旧版 app-data（改过的旧 SKILL.md + 未改的旧出厂文件 + package.json，无 manifest）→ 升级解析后：references 补播、未改文件更新为新内容、改过文件保留、package.json 被删。
  - manifest 在场的常规升级：未改文件更新、改过文件保留、manifest 登记值始终为真实出厂哈希。
  - manifest 损坏（非法 JSON）→ 视同缺失，按历代哈希判定，不 panic。
  - 用户改过的孤儿（package.json 内容被用户改过）→ 保留不删。
  - 连续两次升级后用户编辑仍保留（adversarial 提出的回归）。
  - 文件已是当前出厂内容时再次解析不产生写入（mtime 不变——竞态防线测试）。
  - 并发首播竞态与 symlink 跳过既有测试不回归。
- **Verification**: `npm run cargo:test` 全绿。

### U2. 恢复内置版本入口（Rust command + React）

- **Goal**: 用户一键回出厂，确认前看到将被覆盖/删除的文件清单（R2）。
- **Requirements**: R2
- **Dependencies**: U1（manifest 与判定逻辑）
- **Files**:
  - 修改 `src-tauri/src/skill_files.rs`（`restore_factory_skills(dryRun)` command）+ `src-tauri/src/lib.rs`（注册）
  - 修改 `src/skills/skill-file-service.ts`、`src/ui/skills/SkillFilePreview.tsx`（按钮 + 确认面板枚举清单）
  - 测试 `src/ui/skills/SkillFilePreview.test.tsx`
- **Approach**: dry-run 复用 U1 判定函数产出差异清单；实跑 = 先把全部出厂文件写 tmp 再连续 rename（收窄混代窗口；进行中的 agent run 按旧指引完成，确认文案注明）+ 登记 manifest + 执行移除清单。用户自建的非出厂文件（如 references/my-notes.md）**保留且不进清单**，确认文案注明「自建文件不受影响」。按钮禁用条件：dev 仓库根 / Resource 只读兜底 / **Resource 不存在**（无出厂源可恢复）。恢复后前端重拉文件列表。确认交互用面板内联确认区（不新增依赖）。
- **Patterns to follow**: 既有 skill_files command 形态（Result<_,String> 中文文案）；SkillFilePreview 既有保存/提示模式。
- **Test scenarios**:
  - Covers AE5：dry-run 返回已编辑文件清单；确认后文件回出厂、孤儿被删、面板刷新。
  - 无任何编辑时 dry-run 清单为空（确认文案不吓人）。
  - dev/只读态按钮禁用。
- **Verification**: `npm test` + `npm run cargo:test` 全绿。

### U3. skill 内容重组：索引 + 双场景 reference + 协议上移 + 删 package.json

- **Goal**: 目录结构与内容三层归位落地（R3/R4）+ 规范图 preset 表全部内容与格式锚点（R8 完整承接于本单元）。
- **Requirements**: R3, R4, R8
- **Dependencies**: 无（文件内容工作；与 U1 并行安全）
- **Files**:
  - 重写 `.claude/skills/tsn-topology/SKILL.md`（主索引：领域语义表 + 回复边界 + 场景路由表 + 文件头消费方式注释）
  - 新建 `.claude/skills/tsn-topology/references/generic-tsn.md`、`references/aerospace-onboard.md`
  - 删除 `.claude/skills/tsn-topology/package.json`
  - 修改 `src-node/claude-agent-worker.mjs`（SYSTEM_PROMPT_SKELETON 扩充协议不变量，KTD8 清单）
- **Approach**: 宇航 reference preset 表（固定列序 markdown 表）：图 4-1 单跳、图 4-5 双跳、图 5-1 五跳（参数 JSON 含 `endSystemPlacement:"ends-only"`，依赖 U6 落地后才真可用——表先行写入，U6 未合前 preset 行参数会被 initialize 拒绝，单元顺序上 U6 先于真机验证即可）、环网一行；通用 reference：路由 + 推荐默认。两个 reference 均不复述合法域。改 worker 源后 `npm run build:worker`。
- **Patterns to follow**: 现 SKILL.md 的「参数源声明」三层表述；official Pattern 2（索引 = overview + navigation）。
- **Test scenarios**: `Test expectation: none -- 纯内容文件 + 骨架常量字符串扩充（骨架变化由 U4 既有注入测试的骨架断言覆盖）`。worker 既有测试中骨架文案断言若引用被迁移语句需同步。
- **Verification**: `npm test` 全绿；`npm run build:worker` 通过；人工通读三文件确认三层判据执行。

### U4. worker 按场景确定性注入（Node worker）

- **Goal**: 注入 = 索引 + 当前场景 reference + 绝对路径表；未知场景回退通用；审计可断言（R5）。
- **Requirements**: R5
- **Dependencies**: U3（reference 文件存在）
- **Files**:
  - 修改 `src-node/claude-agent-worker.mjs`（buildSystemPromptForStage 场景选择 + 拼接 + 路径表 + 审计字段 scenarioReference）
  - 修改 `src-node/claude-agent-worker.test.mjs`
- **Approach**: KTD4。场景文件读取失败逐级降级：场景 reference 缺 → 通用 reference；通用也缺 → 仅索引 + `skill_reference_unavailable` 审计警告；索引也缺 → 既有 skeleton fail-open 不变。路径表由运行时 readdir 枚举（只列实际存在的 .md；**readdir 自身失败按空表 fail-open**，不崩注入）。改后 `npm run build:worker`。
- **Patterns to follow**: 既有 skillRoot option 注入测试缝（resolvedOptions.X ?? 默认）；mkdtemp 测试构造。
- **Test scenarios**:
  - Covers AE2：宇航场景 → prompt 含宇航 reference 正文 + 不含通用正文 + 含路径表；通用场景反之。
  - 未知场景 id（industrial）→ 回退通用 reference。
  - 场景 reference 文件缺失 → 仅索引 + 审计警告（fail-open 不崩）。
  - 无 scenarioConfigId（stageRunnerInput 缺失）→ 回退通用。
  - 既有骨架/sentinel/单字符串断言不回归。
- **Verification**: `npm test` 全绿；`npm run build:worker`。

### U5. catalog scenarios 字段 + describe_templates 场景过滤（Rust + MCP）

- **Goal**: 场景归属机器可读，候选集按场景闭环（R7）。
- **Requirements**: R7
- **Dependencies**: 无
- **Files**:
  - 修改 `src-tauri/src/topology_compute.rs`（三 descriptor 加 scenarios；catalog 函数接受可选 scenario 过滤）
  - 修改 `src-tauri/src/topology_sidecar_routes.rs`（describe_templates 路由透传 scenario 参数）
  - 修改 `src-node/mcp/topology-tools.ts`（inputSchema 加可选 scenario 字符串）+ `topology-tools.test.ts`
- **Approach**: 归属定死（R7 矩阵）；过滤在 Rust 端做（返回子集），未知 scenario 值返回空列表 + warning 字段（不报错——前向兼容工业）。zod/inputSchema 不枚举场景值（自由字符串）。**注意 handler body 显式转发**：`callSidecarTool` 第三参是发往 sidecar 的 body（当前 `{}`），须同步加 `scenario: pickString(args, "scenario")`，否则 schema 收了参数但 body 永远不带（评审实证陷阱）；测试断言 body 转发。
- **Patterns to follow**: descriptor tags 既有形态；zod-Rust drift 守护测试模式。
- **Test scenarios**:
  - Covers AE4 后半：scenario=aerospace-onboard → 三模板全返回；scenario=generic-tsn → line+ring；不传 → 全量；未知值 → 空列表带 warning。
  - drift 测试扩展：三 descriptor 都有非空 scenarios。
- **Verification**: `npm run cargo:test` + `npm test` 全绿；build:worker（MCP server 同包）。

### U6. generic-line ends-only 参数 + 蛇形折叠布局（Rust + MCP zod）

- **Goal**: 规范图 5-1 五跳线性可生成、布局对图（R10/R11/R12）。
- **Requirements**: R10, R11, R12
- **Dependencies**: 无
- **Files**:
  - 修改 `src-tauri/src/topology_compute.rs`（descriptor 合法域 + 参数解析校验 + 生成分支 + 蛇形布局 + 测试）
  - 修改 `src-node/mcp/topology-tools.ts`（zod 同步）+ `topology-tools.test.ts`
- **Approach**: KTD5。ends-only 校验：endSystemsPerSwitch 必须 1（违例 TopologyErrorOut 精确 path）；端口分配 first-free 游标；生成顺序遵守 imac 身份序规范。布局分支仅 (generic-line && ends-only && switchCount>=5) 触发蛇形；其余路径零改动（既有 generic 测试不回归是硬门）。
- **Execution note**: 布局几何测试先行（坐标快照 + slab 防穿框断言先红后绿——沿用成列修复的测试驱动法）。
- **Patterns to follow**: dual-plane 参数校验/错误形态先例；seg_intersects_rect slab 断言；「对图不对文」（实现期对照 5-1 png）。
- **Test scenarios**:
  - Covers AE3：5 跳 ends-only → 7 节点 6 链路、ES 仅两端、两行 S 形坐标快照、同参全等、无重叠、折返不穿框；endSystemsPerSwitch=2 → 校验错误。
  - per-switch 缺省路径既有测试零回归（布局/端口/确定性）。
  - ends-only + switchCount=3（<5 不折叠）→ 单行直线 + ES 两端。
  - validate_intermediate 对 ends-only 输出 report.ok。
  - zod-Rust 合法域 drift 测试扩展 endSystemPlacement。
- **Verification**: `npm run cargo:test` + `npm test` 全绿。

### U7. 打包目录映射 + verify-skills 反转 + 对账 lint + 清理（构建链 + Rust 断言 + TS）

- **Goal**: 加 reference 零打包配置改动；白名单防残留；三方对账防漂移；删死配置（R9/R13/R14）。
- **Requirements**: R9, R13, R14
- **Dependencies**: U3（文件集定型）、U5（scenarios 字段是对账数据源）
- **Files**:
  - 修改 `src-tauri/tauri.conf.json`（目录映射，KTD6 两级回退）
  - 重写 `scripts/verify-skills.mjs`（映射校验反转 + 纯文本白名单 + R9 两层对账）
  - 修改 `src-tauri/src/commands.rs`（打包断言改写：目录映射存在 + package.json 不得存在 + 删 legacy 逐文件断言）
  - 修改 `src/domain/scenario-config.ts`（删 defaults.topology）+ 关联类型/测试
- **Approach**: 先 `npm run tauri build`（或 bundle dry-run）实测目录条目的子结构保留，决定 KTD6 落点；verify-skills 白名单 = SKILL.md + references/*.md（UTF-8 文本）；R9 对账按 KTD7 正则锚点。删 defaults.topology 同步 ScenarioConfig 类型与消费方（grep 确认零消费后删）。
- **Patterns to follow**: verify-skills 既有 frontmatter 解析；commands.rs 断言测试形态。
- **Test scenarios**:
  - Covers AE6：新增 references/industrial.md 不改打包配置 → verify-skills 绿（目录映射主路径）；放 .js → 红；tauri.conf 残留 package.json 映射 → 红。
  - R9：preset 表写不存在的 templateId → 红；模板声明场景但该场景 reference 无该行 → 红。
  - commands.rs 断言：目录映射在 + package.json 不存在。
  - scenario-config 删字段后 `npm test` 全绿（零消费证明）。
- **Verification**: `npm run cargo:test` + `npm test` + `npm run build:worker`（verify-skills 前置）全绿；release 打包产物含 references 子结构（人工抽查一次）。

---

## System-Wide Impact

- 播种语义从「目录级一次性」变「文件级持续对账」——每次解析多一轮哈希比对（文件数 ×KB 级，无感）；发版流程新增「追加出厂哈希」checklist 项。
- worker 注入内容从固定单文件变场景化——审计新增 scenarioReference 字段，排查口径更新。
- 存量已播种安装升级后将经历一次「未编辑文件批量更新 + package.json 删除」——AE1 是该路径的安全网。
- verify-skills 从结构校验升级为内容对账——skill 文档写错 templateId 会挡在 CI，文档作者（含 agent 自己改 SKILL.md 时）受新约束。

---

## Risks & Dependencies

- **sha2 依赖**：实施时核实 Cargo 传递依赖；确需新增 crate 则暂停征求授权（工作规则）。
- **目录映射结构保留**：KTD6 两级回退已备；实测放在 U7 最先做。
- **U3 preset 表先行于 U6**：图 5-1 preset 行在 U6 合入前不可执行——单分支内按 U6 → U3 完成顺序合并消解（或同 PR 同时落）。
- **U5 先行于 U7**：R9 对账以 catalog scenarios 字段为数据源。
- **AE1 生产路径口径**：若 release-writable 与本特性同 release 发车，「无 manifest 存量首升」在生产中只覆盖验收机/中间构建——单测仍防御性保留，但真机验收不以该路径为主验证手段。
- **协议上移错划**：KTD8 清单逐条 commit 可追溯；真机验证「编辑指引仍生效、协议改不动」。
- 既有 release-writable 分支未合并——本特性堆叠其上，验收/合并顺序：先 release-writable 后本特性（同链 PR）。

---

## Assumptions

- boss 已授权完整流程自主执行（plan → work → review → commit，不 push 待真机验收）。
- 蛇形行容量公式与行距常量在「对图不对文」校准下可调，不视为需求变更。
- 历代哈希清单覆盖「上一个执行过播种的构建」（release-writable 分支内容）+ v0.4.1 冗余，超集方案对任何发布序列安全。
