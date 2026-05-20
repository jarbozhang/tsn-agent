---
title: "MVP NED 导出契约"
type: contract
date: 2026-05-20
---

# MVP NED 导出契约

当前 MVP 的 `tsnagent/generated/network.ned` 只承诺基础 TSN 拓扑，不承诺完整 TSN 行为配置。它用于在 INET/OMNeT++ 中建立可继续配置的网络结构。当前同时生成一个最小 `omnetpp.ini`，只负责加载并运行该网络；后续 gPTP、TAS、CBS、ATS、FRER/stream redundancy 和业务流参数需要由独立 `inet-export` skill 扩展。

## 目标

- INET 版本：先按 INET 4.x 族系处理。
- NED package：`tsnagent.generated`。
- NED 文件路径：`tsnagent/generated/network.ned`，必须与 package 目录匹配。
- network 名称：`TsnAgentNetwork`。
- network 基类：`inet.networks.base.TsnNetworkBase`。
- 交换机模块：`inet.node.tsn.TsnSwitch`。
- 端系统模块：`inet.node.tsn.TsnDevice`。
- 端口连接：使用 `ethg++` 自动扩展 gate。
- 链路速率：从 canonical link 的 `dataRateMbps` 导出。
- 连接 channel：`inet.node.ethernet.EthernetLink { datarate = ...; }`。
- 接口速率：在 network parameters 中设置 `*.eth[*].bitrate = default(...Mbps)`，避免 Cmdenv 运行时提示交互式输入。
- 最小 INI：`omnetpp.ini` 设置 `network = tsnagent.generated.TsnAgentNetwork`、`sim-time-limit`、`cmdenv-interactive = false` 和 `cmdenv-express-mode = true`。

## 必需 import

```ned
import inet.networks.base.TsnNetworkBase;
import inet.node.ethernet.EthernetLink;
import inet.node.tsn.TsnDevice;
import inet.node.tsn.TsnSwitch;
```

## MVP 暂不承诺

- 不生成 INET gate schedule configurator 输入。
- 不执行 INET 内置规划。
- 不配置 gPTP 时钟域。
- 不配置 TAS gate control list。
- 不配置 CBS/ATS/FRER。
- 不保证规划器输出可直接反向写入 NED。

## 后续完整 `.ini` 所需元数据

Canonical model 和 manifest 需要保留但不强制解释以下信息，供后续 `inet-export` skill 扩展 `omnetpp.ini` 或调度配置：

- stream name、源/目的端系统、UDP port、PCP。
- period、frame size、latency/jitter 需求。
- route/path 中的 node/link 稳定 ID。
- 默认链路速率和时间同步假设。

## 文档依据

INET 本地示例 `src/inet/networks/tsn/TsnLinearNetwork.ned` 使用 `TsnNetworkBase`、`TsnDevice`、`TsnSwitch` 和 `EthernetLink` 建立 TSN 拓扑；`showcases/tsn/combiningfeatures/gptpandtas/GptpAndTasShowcase.ned` 也使用同一组 TSN 节点模块。gPTP、TAS 和 gate scheduling 示例主要通过后续 `.ini` 配置启用。因此当前只把 NED 限定为拓扑层，`omnetpp.ini` 限定为可加载运行的最小配置，避免把未验证的时间同步和调度参数硬塞进初始导出。

已在 devserver 的 INET 4.6.0 / OMNeT++ 6.4.0 上验证当前导出布局：

```bash
cd ~/tsn-agent-inet-verify
inet -u Cmdenv -f omnetpp.ini -n .
```

验证结果：`tsnagent.generated.TsnAgentNetwork` 能加载并运行到 `sim-time-limit`。
