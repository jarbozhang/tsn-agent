# ADR 0001: 使用本地 SQLite 保存会话工作台数据

## 状态

已接受

## 背景

TSN Agent 需要支持多个会话之间的切换、复制、删除和检索。一个会话不仅包含最终导出的文件，还包含对话过程、阶段状态、步骤快照、canonical TSN 模型、导出清单、项目路径和用户备注。如果只依赖项目目录文件，应用需要反复扫描目录并重新推断工作台状态，复制和检索也会变得脆弱。

同时，项目目录中的 `simulation/inet/tsnagent/generated/network.ned`、`simulation/inet/omnetpp.ini`、`simulation/inet/traffic.ini`、`workspace/react-flow-topology.json`、`planner/flow_plan_1.json` 和 manifest 必须能独立交给规划器、INET/OMNeT++ 或其他工具使用，不能被锁进应用私有数据库。`planner/flow_plan_result_1.json` 属于外部规划器输出，MVP 只在它存在时把它记录为外部观测文件。

## 决策

MVP 使用本地 SQLite 作为应用工作台数据库，但第一版只实现最小恢复层。SQLite 在 MVP 中保存当前会话、最近会话列表、canonical state、步骤快照、导出清单摘要和项目目录引用。项目可交付文件继续写入项目目录，SQLite 不作为项目交付格式。

Tauri 应用优先通过 Tauri SQL plugin v2 接入 SQLite，并使用 migration 管理 schema 演进。数据库文件放在应用配置目录，例如 `sqlite:tsn-agent.db`。

完整会话平台能力后置到 hardening，包括会话复制、删除项目目录、复杂搜索/筛选、FTS5、消息全文索引、软删除/purge 和数据库损坏恢复。

## 数据放置规则

适合放入 SQLite：

- 会话元数据：ID、名称、创建时间、更新时间、阶段状态、来源会话 ID、项目路径、标签、备注。
- 会话列表索引：拓扑规模、流数量、最近步骤、最近消息摘要、导出状态。
- 对话消息：角色、时间、可展示文本、agent event 类型、工具状态摘要。
- 步骤快照：阶段名称、canonical state JSON、export manifest JSON、快照摘要。
- 检索字段：名称、标签、备注、拓扑摘要、流摘要、最近消息摘要。

MVP 首版只需要其中的最小子集：当前会话、最近会话、canonical state、步骤快照、export manifest 和项目路径。其余字段可以预留迁移方向，但不应阻塞第一条新手纵向闭环。

诊断日志也属于工作台数据，但应使用独立表保存，不混入会话 payload。日志只记录按会话归属的脱敏摘要，包括 Claude 交互、会话状态写入和 artifact bundle 刷新；删除会话时同步删除对应日志。

不适合放入 SQLite 作为唯一来源：

- `simulation/inet/tsnagent/generated/network.ned`
- `simulation/inet/omnetpp.ini`
- `simulation/inet/traffic.ini`
- `workspace/react-flow-topology.json`
- `planner/flow_plan_1.json`
- 外部生成的 `planner/flow_plan_result_1.json`
- 项目 manifest
- INET/OMNeT++ 后续需要直接读取的配置文件

不应放入 SQLite：

- Claude Code 凭证、本机密钥、API token。
- 下游规划器或仿真工具的敏感配置。
- raw stdout/stderr、环境变量、Claude 配置文件内容或凭证样式字符串。
- 可以从 canonical state 确定性再生成、且体积很大的缓存产物。

## 结果

收益：

- 会话切换、复制、删除和检索可以稳定实现，不依赖扫描导出目录。
- 新手可以保留多个探索分支，并从任一会话恢复上下文。
- 项目目录仍是开放交付边界，不被应用数据库绑定。
- 后续可以逐步加入 FTS5、最近使用、标签和恢复机制。
- 第一版不会因为完整会话平台而阻塞从一句拓扑意图到导出文件的验证。

代价：

- 需要 schema migration、数据库损坏恢复和删除语义测试。
- 会出现“数据库状态”和“项目目录文件”两个边界，必须通过 manifest 和 session service 保持关系清晰。

## 备选方案

- 只使用项目目录 JSON：实现简单，但会话列表、检索、复制和删除语义容易依赖目录扫描，长期脆弱。
- 使用纯前端 localStorage/IndexedDB：适合浏览器原型，但 Tauri 桌面应用需要更明确的迁移、备份和 SQL 查询能力。
- 使用外部数据库：对本机桌面 MVP 过重，也会增加部署和账户成本。

## 验证

- migration 可重复运行。
- MVP 覆盖当前会话创建、读取、最近会话列表、canonical state、步骤快照和 export manifest 恢复。
- 完整会话复制、删除和搜索在 hardening 阶段覆盖。
- 导出的 `simulation/inet/tsnagent/generated/network.ned`、`simulation/inet/omnetpp.ini`、`simulation/inet/traffic.ini`、`workspace/react-flow-topology.json` 和 `planner/flow_plan_1.json` 不依赖 SQLite 即可被下游工具读取。
