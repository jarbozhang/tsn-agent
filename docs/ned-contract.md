---
title: "MVP NED 导出契约"
type: contract
date: 2026-05-20
---

# MVP NED 导出契约

当前 MVP 的 `network.ned` 只承诺基础拓扑，不承诺完整 TSN 行为配置。它用于在 INET/OMNeT++ 中快速建立软件仿真骨架，后续 gPTP、TAS、CBS、stream redundancy 和 INI 参数需要由独立 skill 继续生成。

## 目标

- INET 版本：先按 INET 4.x 族系处理。
- NED package：`tsnagent.generated`。
- network 名称：`TsnAgentNetwork`。
- 交换机模块：`inet.node.ethernet.EthernetSwitch`。
- 端系统模块：`inet.node.inet.StandardHost`。
- 端口连接：使用 `ethg++` 自动扩展 gate。
- 链路速率：从 canonical link 的 `dataRateMbps` 导出。

## MVP 暂不承诺

- 不生成 `.ini`。
- 不配置 gPTP 时钟域。
- 不配置 TAS gate control list。
- 不配置 CBS/ATS/FRER。
- 不保证规划器输出可直接反向写入 NED。

## 文档依据

INET 文档示例使用 `StandardHost`/以太网能力节点、`EthernetSwitch` 和 `ethg` gate 连接有线网络；gPTP 文档把 TSN 时间同步作为后续 `.ini` 配置层处理。因此 MVP 先把 NED 限定为拓扑层，避免把未验证的时间同步和调度参数硬塞进初始导出。
