---
title: Tauri 整目录资源映射把 .DS_Store 打进 release 并播种进用户 app-data
date: 2026-06-12
category: integration-issues
module: skills-packaging-seeding-pipeline
problem_type: integration_issue
component: tooling
symptoms:
  - "macOS Finder 产生的 .claude/skills/.DS_Store（构建机上真实存在）经 tauri.conf.json 目录资源映射整目录打入 release bundle，打包期无法过滤"
  - "构建闸 verify-skills.mjs 只遍历含 SKILL.md 的目录且显式豁免 .DS_Store/*.swp，根层散文件与垃圾文件静默放行（全绿）"
  - "Rust 播种 collect_files_recursive 无文件名过滤，会把打包进来的垃圾文件播入每个用户的 app-data skills 目录"
  - "垃圾文件被登记进 factory manifest 成为出厂内容，面板显示层隐藏 .DS_Store——不可见垃圾被永久托管、restore 反复回写"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
related_components:
  - development_workflow
tags: [tauri, ds-store, resource-bundling, build-gate, factory-seeding, defense-in-depth, macos]
---

# Tauri 整目录资源映射把 .DS_Store 打进 release 并播种进用户 app-data

## Problem

将 skill 打包从逐文件资源映射切换为整目录映射（`src-tauri/tauri.conf.json`：`"../.claude/skills/": ".claude/skills/"`）后，构建机上 Finder 自动生成的 `.claude/skills/.DS_Store` 会被原样打进 release Resource；Rust 播种链路（`collect_files_recursive`，当时无文件名过滤）会把它当出厂文件复制进每个用户的 app-data skills 目录并登记进出厂 manifest。该污染链由对抗性代码评审构造并实证（构建机上确实存在该 6KB 文件），在发布前修复。

## Symptoms

- 用户 app-data skills 目录里出现 `.DS_Store`，被注册为「出厂文件」，由 restore 流程永久托管、反复回写
- 面板看不到（显示层过滤了 `.DS_Store`）——污染对用户和开发者都不可见
- restore 确认清单中出现 `.DS_Store` 条目，污染恢复体验
- 构建闸 `scripts/verify-skills.mjs` 全绿放行，开发者无任何信号

## What Didn't Work

**原白名单设计为什么失效**：旧闸的枚举范围和豁免规则都是 per-file 映射时代的产物。

1. **枚举范围漏洞**：`listProjectSkills()` 只收集含 `SKILL.md` 的目录——skills 根层的散文件从不被检查，无 `SKILL.md` 的杂目录被静默跳过。per-file 时代这无所谓：没写进映射表的文件根本不会打包。整目录映射后，「没被枚举到」≠「不会被打包」。
2. **显式豁免漏洞**：旧 `listSkillFiles` 对 skill 目录内的 `.DS_Store`/`*.swp` 显式豁免，使其绕过纯文本白名单检查。per-file 时代豁免无害（反正不打包）；整目录时代豁免即放行。

**为什么 "gitignore .DS_Store" 不够**：Tauri bundling 读的是构建机的工作树文件系统，不是 git 索引。`.DS_Store` 被 gitignore 只意味着不进版本库，文件仍真实存在于目录里，整目录映射照样打进包。闸里另有 `isGitIgnored` 检查要求 skill 文件必须被 git 跟踪——但该检查只对已被枚举到的文件生效，枚举范围本身有洞时形同虚设。

**历史先例**：`docs/plans/2026-06-09-001-refactor-topology-skill-source-of-truth-plan.md` 曾删除过 `.claude/skills/tsn-topology/.DS_Store` 并明确标注「.DS_Store 回归（低）：macOS 可能重新生成」风险——本次事件正是该风险在打包链路上的实际兑现。「删一次 + gitignore」不是收口。

## Solution

三处修改，两层防御（commits e454521 + 3d30ec2）。

**(a) 运行时防御** — `src-tauri/src/skill_files.rs` 的 `collect_files_recursive` 加 junk 名过滤（播种与 restore 共用此枚举，一处过滤两条链路同时干净）：

```rust
/// 过滤 .DS_Store/*.swp/原子写 tmp 残片：整目录打包会把开发机 Finder 元数据带进
/// Resource，无此过滤会被当出厂文件播种进用户 app-data 并污染恢复清单。
fn collect_files_recursive(base: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    fn is_junk_name(name: &str) -> bool {
        name == ".DS_Store" || name.ends_with(".swp") || name.contains(".tmp-")
    }
    fn walk(base: &Path, current: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
        for entry in entries {
            if is_junk_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            // ...
        }
    }
}
```

**(b) 构建闸防御** — `scripts/verify-skills.mjs` `main()` 新增全树扫描，根层散文件与无 `SKILL.md` 目录直接报错：

```js
// 整目录映射把 .claude/skills 全树打进包：根层散文件（含 .DS_Store）与
// 无 SKILL.md 的目录无法在打包时排除，必须在构建前阻断。
const rootEntries = await readdir(skillRoot, { withFileTypes: true });
for (const entry of rootEntries) {
  if (entry.isFile()) {
    errors.push(`${skillRoot}/${entry.name} is a stray root-level file; the directory bundle would ship it — remove it.`);
  } else if (entry.isDirectory() && !skillNames.includes(entry.name)) {
    errors.push(`${skillRoot}/${entry.name}/ has no SKILL.md; the directory bundle would ship it — remove it or add SKILL.md.`);
  }
}
```

**(c) 移除豁免** — `listSkillFiles` 不再跳过 `.DS_Store`/`*.swp`，让它们落入纯文本白名单检查（只允许 `SKILL.md` 与 `references/*.md`）并报错：

```js
// listSkillFiles 内（豁免移除处）：
// 不豁免 .DS_Store/*.swp：整目录打包会把它们带进 Resource，落入白名单
// 检查报错让开发者在构建前删除。

// main() 内的既有白名单检查（豁免移除后开始对 junk 文件生效）：
const allowed = relative === "SKILL.md" || /^references\/[^/]+\.md$/.test(relative);
if (!allowed) {
  errors.push(`${filePath} is not allowed; skill directories may only contain SKILL.md and references/*.md.`);
}
```

**验证**：闸加固后首跑即抓到构建机上真实存在的 `.claude/skills/.DS_Store`（随即删除）；红路径实测——skill 目录放 `evil.js` → 报红；preset 表写错 `templateId` → 双重报红。

## Why This Works

打包环节本身无法过滤：Tauri 整目录资源映射是逐字复制，没有 exclude 机制。因此防御只能放在打包前后两端：

- **闸（pre-build）**：`verify-skills.mjs` 在 `build:worker` 前置运行，把「构建机工作树状态」挡在包外——保护所有用户不受单台开发机文件系统状态影响。错误信息直接说明后果（"the directory bundle would ship it"）和动作（"remove it"）。
- **运行时过滤（consumption）**：`is_junk_name` 在播种/restore 枚举处兜底——即使某个包绕过了闸（本地无 CI 直接打包、未来闸改坏、历史已发布的污染包），junk 文件也不会被写进用户 app-data 或登记进 manifest。

两层缺一不可：只有闸，则任何绕过构建脚本的打包路径都裸奔；只有运行时过滤，则污染文件仍被分发（包体积、签名内容里带着开发机元数据），且过滤规则一旦有遗漏（如新的编辑器残留格式）就无第二道防线。

## Prevention

1. **从 per-file allowlist 打包切到目录映射打包时，校验脚本里每一条「无害豁免」都变成洞。** 豁免的安全性依赖「未列出即不打包」这一前提；目录映射反转了前提（「存在即打包」），所有继承下来的豁免必须重审。
2. **安全形态是「枚举一切 + 白名单」**：扫描整棵树，每个条目要么命中显式 allowed 模式、要么报错——而不是「枚举已知好目录、检查其中已知坏模式」。后者的盲区（根层文件、无标记目录）正是本 bug 藏身处。
3. **红路径必须实测变红**：闸改完后用真实坏输入（stray `evil.js`、typo `templateId`）验证它确实报错，而不是只看好输入全绿。
4. **gitignore 不是打包过滤器**：凡是读工作树的构建步骤（资源复制、目录打包），git 的忽略规则对它不可见；不能用 `.gitignore` 替代打包侧的内容控制。

## Related Issues

- `docs/plans/2026-06-12-001-feat-scenario-skill-split-plan.md` — 引入目录映射方案（KTD6）与 verify-skills 重写（U7）的实施计划，本文档的直接上游
- `docs/plans/2026-06-11-002-feat-release-writable-skill-plan.md` — Rust 播种管线的来源计划，即垃圾文件进入用户 app-data 的传播路径
- `docs/plans/2026-06-09-001-refactor-topology-skill-source-of-truth-plan.md` — 历史先例：曾删 `.DS_Store` + gitignore 并标注回归风险，本次为该风险兑现
- GitHub issues：无相关（已搜 "DS_Store bundle resource" 与 "skill seeding"）
