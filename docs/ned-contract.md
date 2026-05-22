---
title: "MVP NED 导出契约"
type: contract
date: 2026-05-20
---

# MVP NED 导出契约

当前 MVP 的 `simulation/inet/tsnagent/generated/network.ned` 只承诺基础 TSN 拓扑，不承诺完整 TSN 行为配置。它用于在 INET/OMNeT++ 中建立可继续配置的网络结构。当前同时生成 `simulation/inet/omnetpp.ini` 和 `simulation/inet/traffic.ini`：前者作为 INET 入口，后者提供第一版 UDP source/sink 业务流。后续 gPTP、TAS、CBS、ATS、FRER/stream redundancy 和规划结果回写需要由独立 `inet-export` skill 扩展。

## 目标

- INET 版本：先按 INET 4.x 族系处理。
- NED package：`tsnagent.generated`。
- NED package 内路径：`tsnagent/generated/network.ned`，必须与 package 目录匹配；导出 artifact 路径为 `simulation/inet/tsnagent/generated/network.ned`。
- network 名称：`TsnAgentNetwork`。
- network 基类：`inet.networks.base.TsnNetworkBase`。
- 交换机模块：`inet.node.tsn.TsnSwitch`。
- 端系统模块：`inet.node.tsn.TsnDevice`。
- 端口连接：使用 `ethg++` 自动扩展 gate。
- 链路速率：从 canonical link 的 `dataRateMbps` 导出。
- 连接 channel：`inet.node.ethernet.EthernetLink { datarate = ...; }`。
- 接口速率：在 network parameters 中设置 `*.eth[*].bitrate = default(...Mbps)`，避免 Cmdenv 运行时提示交互式输入。
- INET 入口：`simulation/inet/omnetpp.ini` 设置 `network = tsnagent.generated.TsnAgentNetwork`、`sim-time-limit`、`cmdenv-interactive = false`、`cmdenv-express-mode = true`，并 include 同目录 `traffic.ini`。
- 第一版业务流：`simulation/inet/traffic.ini` 从 canonical flows 导出 `UdpSourceApp` / `UdpSinkApp`、目标端系统、UDP port、frame size 和 period，只承诺发包/收包，不承诺 TSN shaping 或规划结果回写。

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
- 不生成 `streams.ini`、`routing.ini`、`schedule.ini` 等完整 TSN 仿真占位文件。

## 后续完整 `.ini` 所需元数据

Canonical model 和 manifest 需要保留但不强制解释以下信息，供后续 `inet-export` skill 扩展 `traffic.ini`、stream 配置或调度配置：

- stream name、源/目的端系统、UDP port、PCP。
- period、frame size、latency/jitter 需求。
- route/path 中的 node/link 稳定 ID。
- 默认链路速率和时间同步假设。

## 文档依据

INET 本地示例 `src/inet/networks/tsn/TsnLinearNetwork.ned` 使用 `TsnNetworkBase`、`TsnDevice`、`TsnSwitch` 和 `EthernetLink` 建立 TSN 拓扑；`showcases/tsn/combiningfeatures/gptpandtas/GptpAndTasShowcase.ned` 也使用同一组 TSN 节点模块。INET TSN 示例中的 `UdpSourceApp` / `UdpSinkApp` 使用 `io.destAddress`、`io.destPort`、`source.packetLength`、`source.productionInterval` 和 `io.localPort` 配置基础业务流。gPTP、TAS 和 gate scheduling 示例主要通过后续 `.ini` 配置启用。因此当前只把 NED 限定为拓扑层，把 `traffic.ini` 限定为 UDP 发包层，避免把未验证的时间同步和调度参数硬塞进初始导出。

devserver 的 INET 4.6.0 / OMNeT++ 6.4.0 手动验证命令：

```bash
cd <export-dir>/simulation/inet
inet -u Cmdenv -f omnetpp.ini -n .
```

验证目标：`tsnagent.generated.TsnAgentNetwork` 能加载并运行到 `sim-time-limit`，且 `traffic.ini` 中的 UDP source/sink 能产生 packet。
