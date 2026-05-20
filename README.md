# TSN Agent

## 诊断日志

应用提供按会话归属的诊断日志，用于排查 Claude 交互、会话保存和导出文件刷新问题。点击顶部“日志”按钮可以查看当前会话的日志时间线。

日志只保存脱敏后的摘要，例如 run id、是否 resume、chunk 统计、session 保存状态、artifact 文件路径和错误摘要。不要把日志当作项目交付产物；`.ned`、`omnetpp.ini`、React Flow JSON、`flow_plan_1.json` 和 manifest 仍然是独立文件边界。详细契约见 `docs/diagnostics-log-contract.md`。

TSN Agent 是一个 Tauri + React 桌面应用 MVP，面向了解 TSN 概念但不熟悉参数配置的新手用户。当前纵向闭环支持输入一句网络规模描述，例如“我需要 4 个交换机，每个交换机连接 5 个端系统”，应用会生成拓扑草案、1 条控制流模板和两类导出文件：

- `tsnagent/generated/network.ned`：面向 INET/OMNeT++ 的最小 NED 网络文件，路径与 `tsnagent.generated` package 匹配。
- `omnetpp.ini`：最小 Cmdenv 运行配置，用于加载生成的 NED 网络。
- `react-flow-topology.json`：给 React Flow 展示用的拓扑 JSON。
- `flow_plan_1.json`：兼容现有规划器输入样例的 `base + stream_info` 结构。
- `manifest.json`：导出文件清单。

`flow_plan_result_1.json` 不由 MVP 默认生成；如果外置规划器后续写入该文件，应用只把它识别为外部规划器输出，不解析 GCL/interface 摘要。

生成草案后点击“保存”可以导出当前 artifact bundle。Web 开发/E2E 环境会显示 `browser-preview` 状态；Tauri 运行时会给出推荐导出目录，点击“选择目录”会打开系统目录选择器；保存成功后可以点击“打开目录”直接进入本次导出的文件夹。导出会拒绝 repo 根目录、home 根目录、应用配置目录、根目录和 symlink 目标。

当前 `omnetpp.ini` 只承诺能让 INET/OMNeT++ 加载并运行基础拓扑；gPTP、TAS/GCL、调度器选择、业务流应用和规划结果回写仍放在后续 `inet-export` skill 中扩展。

当前版本在 Tauri 中通过本机 Node worker 调用官方 `@anthropic-ai/claude-agent-sdk`，复用用户本机 Claude Code 配置；Web/E2E 环境自动回退到 fake agent，保证测试不依赖真实 Claude 凭证。会话支持新建、切换、复制、删除；Tauri 运行时使用 SQLite 保存最小恢复状态，普通 Web/测试环境使用浏览器 `localStorage` 回退。

## 开发

```bash
npm install
npm run dev
```

Tauri 开发入口：

```bash
npm run tauri dev
```

## 测试

```bash
npm test
npm run build
npm run e2e
npm run cargo:test
```

测试范围说明见 `docs/testing.md`。

真实 Claude 对接要求本机已安装 Node.js，并且 Claude Code 已完成登录。应用不会读取或保存 Claude Code 凭证，SQLite 只保存脱敏后的会话文本、agent event 摘要、canonical state 和导出清单。

## 目录边界

`tsn-topology/` 是已有的独立 skill 仓库，当前存在未提交修改。根目录应用把它作为只读迁移参考，不纳入根 Git 管理，也不会在本 MVP 中修改其中内容。
