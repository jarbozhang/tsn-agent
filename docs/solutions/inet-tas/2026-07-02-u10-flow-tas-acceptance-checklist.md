---
title: U10 flow+TAS 验收清单（docx 8 用例 + ST+BE 混合 + 坏 GCL 对照）
date: 2026-07-02
module: flow-planning / inet_sim
plan: docs/plans/2026-07-01-002-feat-flow-tas-qbv-inet-plan.md
layer: 真机验收（不进 CI 门；CI 回归见各单元 mock 单测 + flow_verify_command e2e）
---

# U10 验收：两层分清

R18-R20/R24 的验证分两层（plan U10）：

- **CI 回归层（已落地，随各单元）**：`MockPlanClient`（U7 `flow_plan_command` 单测）/
  `MockRunner`（U8 `flow_verify_command` 单测）喂**冻结的** GCL/CSV 做确定性断言——录流校验闸
  （`flow_verify`）、路由推导（`flow_route`）、GCL 解析、对账谓词（`flow_reconcile`）、per-stream
  classify、坏 GCL 判 FAIL、以及 **plan→verify 端到端接缝**（`e2e_plan_then_verify_pipeline` /
  `e2e_bad_gcl_fails_verification`）。这些**不打宿主机**、进 CI 门。
- **真机验收层（本清单，人工，不进 CI 门）**：3 拓扑 × Qbv 端到端（录流→plan_tas→verify_tas
  PASS）+ ST+BE 混合 + 坏 GCL 对照，真打宿主机 `100.104.38.106:19090`。宿主机单运行锁把 8 用例
  ×分钟级 plan+verify 串行化，墙钟成本高，故不进 CI。

## ⚠ 前置：docx 期望值缺口（需 boss 提供）

计划要求「docx 8 用例期望值只写一次（共享 Rust const）」作为唯一事实源。**本期实现落地了
完整录流→规划→验证管道 + 上述 CI 回归，但 docx 的 8 个 Qbv 用例的具体数据（每用例的流集
参数、per-hop 期望门窗、期望时延）需要 docx 原文**。拿到 docx 后：
1. 建 `src-tauri/src/flow_docx_fixtures.rs`（或 tests fixture），把 8 用例的 (拓扑, 流集, 期望门窗,
   期望结果) 写为共享 const（U7 对账单测 + 本清单验收共用、grep 断言无重复硬编码，R20）。
2. 用 `flow_reconcile::reconcile(synth_gcl, docx_expected_gcl, cycle)` 做对账（R9 等价即通过）。
3. 双跳拓扑（4ES+4SW）造夹具时**核对 docx 拓扑不含同 plane 等价多路径**（否则触发 U5
   `AMBIGUOUS_ROUTE`，与「必须通过」冲突，见 plan Open Question）。

## 验收步骤（每用例）

前置：宿主机薄服务在跑（`/sim/healthz` 绿）；app 设置里配了软仿 HTTP 地址；工程处于
flow-template 阶段（U4 解冻后）。

1. **录流**：经会话 agent 的 flow 工具（U3）或直接 `/db/flow/add_stream` 录入该用例流集。
   校验闸拒绝非法流（周期∤门控周期 / 报文>MTU / talker 不在拓扑 / 同 pcp 异 class）。
2. **规划**：触发 `plan_tas`。期望 `status=ok`、`solver=Z3`（带保证）、`gateCount>0`；
   `flow_plans` 落库。不可行用例期望 `status=solver_failed` 且 flow_plans 空（R10）。
3. **对账（辅助）**：综合 GCL 与 docx 门窗跑 `flow_reconcile`——等价（全局相移）即绿；真正不同
   合法解记 mismatch→排查（不阻断）。
4. **验证**：触发 `verify_tas`。期望每流 `pass=true`：收=发（0 丢包）、jitter<1us、时延≤窗口。
   `status=ok`。空/短结果**绝不**渲染绿（R16）。

## 用例矩阵

| # | 拓扑 | 流 | 期望 |
|---|---|---|---|
| 1-N | docx Qbv 用例（双平面单跳 6ES+2SW / 双平面双跳 4ES+4SW / 5 跳线性 2ES+5SW） | docx 定 | plan ok + verify 每流 PASS |
| R19 | 5 跳线性 或 双跳 | **ST + BE 混合**（新增场景）：ST pcp7 + BE pcp0 灌满剩余带宽 | ST 收=发且 jitter<1us（BE 灌满下不劣化）；BE 仅涓流不算通过 |
| R24 | 任一 | **故意坏 GCL**（两 ST 同端口同窗开门碰撞） | verify 判 FAIL（证闸能区分好坏排程） |
| CB | 双平面 RC | 冗余流（802.1CB） | **xfail**（本期 FRER 不实现，只留双路径不相交断言；标占位、不算已通过） |

## 真机注意（承前 U1/U6 spike + timesync 教训）

- **丢包判据「发送数」**（plan Open Question）：本期 verify 以流 `count` 为期望发送数判收=发。
  真机若源按 productionInterval 连续发（非按 count 界定），需二选一并在此钉死：①给 pin bundle 的
  source 加发送上限（=count）；②服务 verify 补导 `.sca` 的 `packetSent:count`、verify 改比对它。
  先真机 dump 一次确认 sink 侧 `packetLifeTime:vector` 的真实样本数对 count 的关系。
- **向量真实 module 路径**：classify 按 `<listener_ned>.app[<j>].sink` 后缀匹配；真机确认 sink
  app 的 packetLifeTime/packetJitter module 路径与此一致（对齐 U1 spike `server*.app[N].sink`）。
- **非理想时钟**：flow bundle 复用 timesync gPTP 同步子栈（U6 `build_sync_block`）——首次组装后
  确认抖动地板非零且有界（漂移无同步会发散→假丢包；恒 0 说明用了理想时钟）。
- **ethg[N] 门向量声明**：真机跑前确认每节点 NED 有 `ethg[N];`（KTD3，golden fixture 已覆盖）。
