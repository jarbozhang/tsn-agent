# R8 基线操作单（阶段 1 文字线改前快照）

plan 的 R8/R11/R15 要求：动 SKILL.md/骨架前先存「改前」基线，改完逐条比对、不凭记忆。
好消息——agent 每次 run 已自动写结构化审计 JSON，基线 = 跑指定流程 + 拷这些 JSON，不用手抄。

## 审计 JSON 在哪、记了什么

- 路径：`~/Library/Application Support/com.tsnagent.app/agent-runs/<session-id>/`
  - 每轮一份 `<时间戳>-<runId>.json`，外加该会话的 `latest.json`。
- 每份含（即基线要比对的）：`userPrompt`、`prompt`（完整注入 prompt）、`skillRoot`、`scenarioReference`、`conversationContext`、`toolCalls`（工具调用序列）、`operationTraceLines`、`timeline`（assistant_chunk 回复文本）、`result`、`stageResults`。

## 跑哪几条流程（逐字输入，保证改前改后一致）

> 用 `npm run tauri dev` 起 app。**每条用全新会话**（避免上下文串味），记下每条用的 session-id（或直接整目录拷）。
> generic-tsn 是默认场景；第 5 条建议另起一个会话专门压「该追问不追问」。

1. **从零初始化（generic）**：`我需要 4 个交换机，每个交换机连接 5 个端系统`
   —— 看 agent 是否 describe_templates → initialize → 出摘要等确认。
2. **增量编辑后 validate**：接着上一会话 → `给 SW-1 再加一个端系统`
   —— 看 inspect → apply_operations → validate → 回报结构结论。
3. **切阶段意图**：确认拓扑进时间同步后 → `我想回去把拓扑改成 3 个交换机`
   —— 看 request_stage_change 是否「第一轮只判意图、不在这轮追问怎么改」。
4. **多-op apply 的 batch 形态**（「重试复用同一 batch」难手动触发超时，改记录一次多操作 apply 的 batch 形状即可）：新会话初始化后 → `把端系统 ES-1 挪到 SW-2，再删掉 SW-3 到 SW-4 的那条线`
   —— 记录 apply_operations 的 operations 数组形态（改后比对键名是否仍 syncName/linkSeq、有无 imac 残留）。
5. **非 happy-path（该追问就追问）**——最关键，改后最容易飘：
   - 新会话 a：`让拓扑更可靠一点`（不指明双/三冗余）—— 看是擅自加节点还是给编号选项追问。
   - 新会话 b：先建一张图，再 `把 ES-1 连到 SW-9`（SW-9 不存在）—— 看是静默新建 SW-9 还是停下澄清。

## 采集（跑完执行）

把改前快照拷进仓库基线目录（本地验证产物，不必提交）：

```bash
SRC=~/Library/Application\ Support/com.tsnagent.app/agent-runs
DST=docs/plans/baselines/phase1-before
mkdir -p "$DST"
# 拷你这轮用到的会话目录（按时间取最近 N 个，或指定 session-id）
cp -R "$SRC"/session-*/ "$DST"/   # 或只 cp 本次跑的几个 session 目录
ls -R "$DST" | head
```

> 注意：审计 JSON 已 redact 脱敏，但仍含 prompt 全文，体量大——建议**不提交**进 git（留本地或加进 .gitignore）。

## 改完怎么比对（U2/U3 之后、build:worker 之后）

1. U2/U3 改完 → `npm run build:worker` → 同样 5 条流程**逐字重跑** → 同样拷到 `docs/plans/baselines/phase1-after/`。
2. 逐条比 `toolCalls`（工具序列/参数）与 `timeline` 的 assistant 文本：

```bash
# 例：比第 1 条流程改前/后某 run 的工具调用序列
python3 - <<'PY'
import json
def tools(p): 
    d=json.load(open(p)); return [(t.get('name'),t.get('input')) for t in d.get('toolCalls',[])]
before="docs/plans/baselines/phase1-before/<sessA>/latest.json"
after ="docs/plans/baselines/phase1-after/<sessA>/latest.json"
b,a=tools(before),tools(after)
print("工具序列一致" if [n for n,_ in b]==[n for n,_ in a] else "⚠️ 工具序列变了")
print("before:",[n for n,_ in b]); print("after :",[n for n,_ in a])
PY
```

3. 判定：**工具调用序列 + 关键参数不变** = 文字线没改坏行为（R8 通过）。第 5 条两个非-happy-path 尤其要看「该追问的还追问、不该擅自新建的没新建」——这正是弱模型最易飘、也是这次理顺最该守住的。
4. 有差异：定位是哪处文字改动引起，回退或修正，别让「搬家+去重」偷偷改了语义。

## 备注

- U1 只改了 `AGENTS.md`（不进 agent 注入 prompt），所以现在的 worker 行为就是基线，**采基线不需要先 build:worker**。
- skillRoot 字段能确认 agent 实际读的是哪份 SKILL.md（真机排查「指引对不对」直接看它）。
