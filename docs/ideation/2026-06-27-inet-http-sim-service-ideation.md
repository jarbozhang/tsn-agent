# 在 INET 宿主机上部署薄 HTTP 软仿服务（替代 app→宿主机 SSH）— ideation

日期：2026-06-27
触发：SSH 免密配置反复受阻（3 台目标两台不可达 + known_hosts/authorized_keys 折腾），boss 提出"不如在 INET 服务器上部署一个很薄的 HTTP 层"。

## 要评估的事

现在 app 跑 INET 软仿是这样：本地生成 bundle（`network.ned` / `omnetpp.ini` / `manifest.json`）→ `ssh mkdir` → `scp -r` 传到 `/tmp/tsn-agent-runs/run-<hex>` → `ssh` 跑 `source nix.sh && opp_env run inet-4.6.0 ... -c 'cd run-<hex> && inet -u Cmdenv ...'` → `ssh` 跑 `opp_scavetool export ... && cat csv` → 本地解析收敛曲线。

boss 想改成：宿主机上跑一个薄 HTTP 服务，app 把 bundle POST 过去，服务在本机跑那条**沉淀好的** opp_env 指令（`source /nix/.../nix-daemon.sh && /home/zhang/.local/bin/opp_env run inet-4.6.0 -w /home/zhang/inet-workspace --build-modes=release`，运行目录 `/tmp/tsn-agent-runs`），把结果回给 app。app 端**只配 host+port**，跟硬件部署 API 一个配置方式。

**问："是否可行"。**

## 结论：可行，而且这条路本项目已经走通过一半

判断依据，不是拍脑袋：

1. **客户端那套 HTTP 模式已经在跑了。** 硬件部署 API（`hardware_api.rs` / `hardware_command.rs`，tsn-sim 服务 `http://host:port/sim/*`）已经把"app 只配一个 baseUrl + reqwest trait 客户端 + 长任务轮询 + 配置三层解析（env>UI>默认）+ task 表"整套跑通并过了 code-review。软仿 HTTP 客户端基本是**照抄改字段**：配置层可复用 ~95%、HTTP 客户端框架 ~100%、设置面板表单 ~90%。

2. **执行逻辑不变，只是换了触发方式。** opp_env 指令、scavetool 取数、那 8 个真机踩出来的坑（尤其 parser 要跳过 opp_env stdout 横幅再定位真 CSV 表头）——这些都原样保留，只是从"app 通过 ssh 远程跑"变成"服务在本机跑"。沉淀到宿主机后，那条又长又脏的 nix+opp_env 指令不再需要 app 配置/传输，正是 boss 要的"沉淀"。

3. **架构上不冲突，反而更一致。** 项目早就确立了"对端是可执行环境（INET 机）→ 系统 ssh/scp；对端是 HTTP 服务（tsn-sim）→ reqwest"两套并存、配置解耦。把 INET 机也包一层 HTTP，等于让两条远程路径**收敛成同一种心智**（都是 host+port + reqwest），app 侧 SSH/scp 那套（known_hosts、ssh-agent、StrictHostKeyChecking、exit 255 分型、定向脱敏裸 IP）整块可以退役。

4. **正好甩掉刚卡住的 SSH 痛点。** app→宿主机的免密、known_hosts 预录、多客户端各自分发公钥——HTTP 方案全没了，新客户端只要知道 URL。
   > 注意区分：我们刚才在配的是**宿主机→另外 3 台**的免密（那 3 台用途未知，可能是别的计算/真机节点），那条链路 HTTP 层**不直接替代**。本想法替代的是 **app→宿主机** 这条。如果那 3 台是"宿主机再往下分发软仿"用的，得单独说；如果只是别的事，本想法和它无关。

## 几个要定的叉口（brainstorm 时拍）

可行没问题，真正要决定的是这几处：

### 叉口 1：服务薄到什么程度——回原始 CSV 还是回结构化结果 ★建议回 CSV
- **A（薄，推荐）**：服务只负责"收 bundle → 跑 opp_env+inet → 跑 scavetool → 回原始 CSV（+ exit code/stderr）"。**那套来之不易的解析/收敛判定逻辑（含横幅跳过）留在 app 的 Rust 里不动**。最小改动、最契合"很薄"、不重复迁移已验证代码。
- **B（厚）**：服务自己解析、回结构化 JSON（offset 收敛曲线）。app 简化，但把 8 个坑的解析逻辑搬到宿主机维护，违背"薄"。
- 倾向 A：服务是纯执行壳，app 解析层零改。

### 叉口 2：一次性同步 vs 异步任务轮询 ★需要你定
- 软仿现在是**一次性同步**（ssh 阻塞等结果，超时给得很宽）。但 opp_env 首次编译可能数分钟。
- **A（同步）**：`POST /sim/run`（带 bundle）→ 阻塞等 → 回 CSV。最简单、最薄；但 HTTP 长请求数分钟，容易被中间层/超时掐（硬件部署的 reqwest 读超时才 30s，这里要专门放宽）。
- **B（异步）**：`POST /sim/run`→`{job_id}`→ 轮询 `/sim/status`→`/sim/result`。直接复用硬件部署那套轮询框架（双定时器/终态权威源/会话守卫），对"软仿是长任务"更稳，还能顺带出进度。
- 这是和"很薄"最冲突的一处：A 更薄但长请求脆，B 更稳但要带轮询。我个人偏 B（框架现成、长任务本就该异步），但取决于你要多薄。

### 叉口 3：服务用什么写 ★建议 Python FastAPI 或单文件
- 宿主机有 nix + python。**FastAPI/Flask + uvicorn** 写这层最快（收 multipart、起子进程跑命令、回 body），几十行。或单文件 Go/Rust 静态二进制（零运行时依赖，但写起来略多）。
- 倾向 FastAPI：薄、好改、宿主机现成。

### 叉口 4：认证与部署形态 ★沿用硬件部署的结论
- 硬件部署现在是 **Tailscale 内网 plain HTTP 无认证**（靠 tailnet 隔离 + WireGuard 加密）。INET 机同在 tailnet → 同模式即可，可选加个静态 token。
- 服务生命周期：systemd unit（开机自起 + 崩溃重启）最稳；临时验证可 nohup/tmux。这部分虽薄，但要有个部署脚本/单元文件。

## 否决/慎选

- **回结构化 JSON（叉口1-B）**：把已验证的解析逻辑迁到宿主机，重复维护、违背"薄"。除非将来想让服务独立于 app 被别的客户端用。
- **公网暴露**：当前无认证模式只在 tailnet 成立；base_url 一旦指公网必须补 token + HTTPS。
- **app 侧立刻删 SSH 软仿路径**：HTTP 服务真机验通前，SSH 那条留着兜底；切换后再清。

## 取舍总结（HTTP 服务 vs 现状 SSH）

| | HTTP 薄服务 | 现状 SSH/scp |
|---|---|---|
| app 配置 | host+port 一项（同硬件部署） | host/user/inetEnvCmd/baseDir 四项 |
| 免密/known_hosts | 不需要 | 需要（刚踩的坑） |
| 多客户端 | 只需 URL | 各自分发公钥 |
| opp_env 指令 | 沉淀在宿主机 | 每次 app 配置/传 |
| 新增维护 | 宿主机多一个常驻服务 + 部署 | 无（但 SSH 配置摊到每个客户端） |
| 执行/解析逻辑 | 不变（叉口1-A） | 不变 |

净评：多客户端 / 想甩掉 SSH 配置摊派的场景，HTTP 服务明显更顺；代价是宿主机多一个要维护的薄服务。

## 下一步

可行性已确认。建议进 **ce-brainstorm** 把叉口 1（薄/厚）、叉口 2（同步/异步）定下来——这两个决定了服务的 API 契约和 app 改动量；叉口 3/4（技术栈/部署）实现时定即可。定完就能 ce-plan。
