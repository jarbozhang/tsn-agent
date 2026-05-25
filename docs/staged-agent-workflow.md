# TSN Agent 分阶段工作流

## 阶段

TSN Agent 当前使用四个稳定阶段 ID：

- `topology`：解析自然语言拓扑规模，生成 canonical 拓扑。
- `time-sync`：展示时间同步默认假设，后续再细化 gPTP、GM 和端口关系。
- `flow-template`：用户可见为“流量规划”，基于当前拓扑准备 ST 控制流/视频流等流量输入，只负责创建和确认流集合。
- `planning-export`：用户可见为“模拟仿真”，刷新项目导出文件，并可启动真实规划任务。基础导出包括 `simulation/inet/omnetpp.ini`、`simulation/inet/traffic.ini`、NED、`workspace/react-flow-topology.json`、`planner/flow_plan_1.json` 和 manifest；当前不执行 OMNeT++。

阶段完成后进入 `waiting_confirmation`，用户点击“确认并继续”才进入下一阶段。显式输入“直接生成”会走快速路径，一次完成四个阶段。

## 事件

执行步骤面板显示用户可理解的事件摘要：

- `stage-start` / `stage-result`：阶段开始和阶段结果。
- `skill-result`：本地阶段 skill 的确定性结果。
- `tool-availability`：当前工具/MCP 可用状态摘要。
- `confirmation-required`：等待用户确认的提示。
- `artifact`：导出清单或规划器输入已刷新。
- 规划任务事件：启动、轮询、busy、停止、读取结果和刷新 artifact，诊断只保存 plan id、状态、耗时、错误和文件摘要。

本轮不解析真实 Claude SDK `tool_use/tool_result` 细节，也不启用 Bash/Edit/Write 类高风险工具。诊断日志继续保存脱敏后的 run id、耗时、chunk 统计和错误摘要。

## ScenarioConfig

`ScenarioConfig` 是轻量应用场景配置模型，负责场景显示名、阶段文案、默认拓扑值、同步说明、流模板和术语映射。核心阶段引擎只依赖稳定阶段 ID，不复制舰载/箭载等场景流程。

第一版内置：

- `generic-tsn`：默认通用 TSN 配置。
- `aerospace-onboard`：箭载/舰载 TSN 典型场景占位配置。

session/workflow state 只保存 scenario config id。未知 id 会回退到 `generic-tsn`，避免旧会话无法打开。

## 导出边界

拓扑、时间同步和流量规划阶段可以存在 project 草案，但 UI 不显示“仿真已执行”或“导出已完成”。只有到 `planning-export` 阶段后，用户才看到仿真输入文件和保存/导出动作。

`planner/flow_plan_1.json` 是规划器输入，不是规划器运行结果。真实规划任务成功并读取结果后，应用才会生成 `planner/flow_plan_result_1.json`，并标记为 `planner-output` / `observedExternal=true`。

成功结果还会追加 `simulation/inet/planner-gcl.json` 和 `simulation/inet/planner-gcl-notes.md`。这两个文件是从真实 `solution_json` 派生的 INET/GCL 可追溯中间产物，保留 link id、stream id、state 和 interval 原值；当前不声明为完整可运行的 TAS gate schedule。
