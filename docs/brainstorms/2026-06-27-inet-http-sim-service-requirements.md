# INET 宿主机薄 HTTP 软仿服务 — 需求

日期：2026-06-27
来源 ideation：docs/ideation/2026-06-27-inet-http-sim-service-ideation.md
范围：Deep-feature（架构改动，沿用项目已有的 HTTP 远程模式）

## 问题

现在 app 跑 INET 软仿是 **app→宿主机 SSH/scp**：本地生成 bundle → scp 传过去 → ssh 跑 `opp_env...inet` → ssh 跑 scavetool 取 CSV → 本地解析。这条路依赖免密、known_hosts、authorized_keys，配置摊到每个客户端，刚因为配免密反复受阻。

硬件部署 API 已经证明了另一条路可行：**app 只配 host+port + reqwest 客户端 + 长任务轮询**。把 INET 机也包一层薄 HTTP，就能让软仿走同一种心智，甩掉 SSH 那套配置摊派。

## 目标

- 宿主机上跑一个**薄** HTTP 服务，把那条又长又脏的 nix+opp_env 指令**沉淀**在宿主机，app 不再配置/传输它。
- app 端配置简化到 **host+port**（同硬件部署）。
- 软仿变成**异步任务**：提交后不阻塞 UI，轮询拿结果。
- 复用已验证的硬件部署轮询框架与 reqwest 客户端模式，**不重建**。
- app 现有的 CSV 解析/收敛判定（含 opp_env 横幅跳过等 8 个真机坑）**原样保留**。

## 非目标

- 不做并发队列（单用户，一次一个软仿）。
- 服务不自带解析（薄 = 回原始 CSV，不回结构化 JSON）。
- 本期不做认证（tailnet plain HTTP，连 token 也不加）。
- 不立刻删 SSH 软仿路径（真机验通后另开 PR 清）。
- 不碰宿主机→其他机器的链路（原本要配的 3 台免密已放弃，本期不相关）。
- 不公网暴露（仅 tailnet）。

## 已定决策

- **D1 架构 = 薄服务 + 异步轮询。** 服务只负责"收 bundle → 跑沉淀指令 → 回原始 CSV + exit code + stderr"；app 走 `POST 提交 → job_id → 轮询 status → 取 result`。
- **D2 沉淀指令固化在宿主机服务**：`source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && /home/zhang/.local/bin/opp_env run inet-4.6.0 -w /home/zhang/inet-workspace --build-modes=release`，运行目录 `/tmp/tsn-agent-runs`。
- **D3 解析留 app**：服务回 raw CSV/exit/stderr，app 现有 `classify_and_compute`（load_failed / scavetool_failed / empty / parse_failed / converged）与横幅跳过解析**复用不动**。
- **D4 过渡 = 先并存后删**：app 加 HTTP 路径，SSH 留兜底；配了 INET HTTP 服务地址就走 HTTP，没配走 SSH；真机验收 HTTP 后另开 PR 清掉 SSH 软仿代码。
- **D5 复用硬件部署模式**：reqwest trait 客户端（真实现 + Fake 测试替身）、配置三层解析（env > UI > 默认）、app_state 持久化、task 表、轮询（双定时器 / 终态权威源 / 会话守卫）。
- **D6 单运行**：服务一次只跑一个软仿，忙时拒绝（不排队）。
- **D7 本期不做认证**：tailnet plain HTTP，不加 token；认证留待将来公网暴露时再补。
- **D8 服务代码进本仓**版本管理（新目录），带部署形态，不是宿主机手写散文件。

## 需求

- **R1** 宿主机薄 HTTP 服务：固化 D2 的 opp_env 指令与运行目录；收 bundle，在 `/tmp/tsn-agent-runs/run-<id>` 下解包并执行软仿 + scavetool 取数。
- **R2** 异步任务 API：提交（带 bundle，返回 job_id）、查状态、取结果（raw CSV + exit code + stderr）。具体端点/schema 留 plan。
- **R3** 单运行语义（R6/D6）：已有任务在跑时，新提交被明确拒绝（非静默）。
- **R4** run 目录管理：每任务独立 `run-<id>` 目录；旧目录定时 GC（策略留 plan）。
- **R5** app HTTP 软仿客户端：reqwest trait（复用 D5），配置 host+port（形态对齐硬件部署的 baseUrl），三层解析、app_state 持久化、设置面板表单。
- **R6** app 异步轮询：复用硬件部署轮询框架（双定时器 / 终态权威 / 会话切换守卫），opp_env 首编译数分钟期间不卡 UI、有进度反馈。
- **R7** 结果消费：app 拿 raw CSV 后走现有解析/收敛逻辑（D3），错误分型与现状一致。
- **R8** 选路与过渡（D4）：配了 INET HTTP 服务地址走 HTTP，否则 SSH 兜底；SSH 软仿代码本期保留，验通后另 PR 清。
- **R9** 安全：tailnet plain HTTP、本期不做认证（D7）；服务端跑**固定**沉淀指令、不拼接用户可控串（注入面比 SSH 小）；bundle 解包路径约束在 run 目录内，防路径穿越。
- **R10** 服务交付：代码进本仓新目录 + 部署形态（倾向 systemd unit，留 plan），可复现部署到宿主机。
- **R11** 前置验证（preflight）：服务启动时（并提供一个 check/healthz 端点，对齐硬件部署的 healthz+task_check）校验宿主机依赖——能 `source` nix-daemon profile、`opp_env` 二进制存在且可跑、Python/FastAPI 运行时就绪、运行目录 `/tmp/tsn-agent-runs` 可写。缺任一项**明确报错并拒绝接任务**（不静默启动然后跑软仿时才挂）；check 端点把缺失项回给 app 展示。
- **R12** README：服务自带一份 README，覆盖前置依赖清单、部署步骤（systemd 安装/启动）、配置（运行目录/端口/沉淀指令在哪改）、前置验证怎么自查、常见故障排查。

## 范围边界

**本期做**：宿主机薄 HTTP 服务（R1–R4、R9、R10）+ 前置验证与 README（R11、R12）+ app HTTP 软仿客户端与轮询（R5–R8）+ 与 SSH 并存。

**Deferred / 后续**：
- 真机验收通过后，另开 PR 删 app 的 SSH 软仿路径（inet_remote/scp/ssh 软仿部分 + inet-host-config 四字段）。
- 并发队列、多用户隔离（当前单用户不需要）。
- 公网暴露所需的 token + HTTPS 强化。
- 服务自带解析回结构化 JSON（若将来要给别的客户端用再说）。

## 成功标准

- app 配好 INET HTTP 服务地址后，对同一拓扑跑软仿，**收敛曲线/结果与现有 SSH 路径一致**（真机对照验收）。
- opp_env 首次编译数分钟期间 UI 不阻塞、有"运行中"反馈。
- 没配 HTTP 地址时，SSH 兜底路径照常工作。
- 服务能从本仓一键/脚本化部署到宿主机，照 README 走得通。
- 宿主机缺依赖（nix/opp_env/Python/运行目录）时，前置验证**明确报出缺哪项**，而不是接了任务才跑挂。

## 待解决问题（留给 plan）

- API 端点与请求/响应 schema（bundle 上传用 multipart 还是 tar、result 怎么回 CSV）。
- run 目录 GC 具体策略（保留 N 个 / 超时清 / 取完即删）。
- app 选 HTTP vs SSH 的开关形态（配置存在即用 vs 显式开关）。
- 服务技术栈（倾向 FastAPI + uvicorn）+ systemd 单元细节。
- 服务在本仓的目录位置与构建/部署脚本。

## 依赖与假设

- 宿主机有 nix + opp_env（已沉淀指令验证过可跑）+ Python（若用 FastAPI）——这些不再当"默默假设"，由 R11 前置验证显式校验、缺则报错。
- INET 机在 tailnet 内，plain HTTP 可接受（同硬件部署既有结论）。
- 硬件部署的 reqwest 客户端框架与轮询框架可复用（已 code-review 过）。
- 现有 app 端 CSV 解析/收敛逻辑稳定，可直接消费服务回的 raw CSV。
