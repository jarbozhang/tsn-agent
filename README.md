# TSN Agent

TSN Agent 是一个 Tauri + React 桌面应用 MVP，面向了解 TSN 概念但不熟悉参数配置的新手用户。当前纵向闭环支持输入一句网络规模描述，例如“我需要 4 个交换机，每个交换机连接 5 个端系统”，应用会生成拓扑草案、1 条控制流模板和 4 个导出产物：

- `network.ned`：面向 INET/OMNeT++ 的最小 NED 网络文件。
- `react-flow-topology.json`：给 React Flow 展示用的拓扑 JSON。
- `flow_plan_1.json`：兼容现有规划器输入样例的 `base + stream_info` 结构。
- `manifest.json`：导出文件清单。

当前版本使用 fake agent 验证产品链路，真实 Claude Agent SDK / Claude Code 本机配置桥接放在后续 hardening。会话支持新建、切换、复制、删除，并先使用浏览器 `localStorage` 作为 Web/E2E 可测的最小恢复层；Tauri SQLite 持久化已在 ADR 中保留为下一阶段实现方向。

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

## 目录边界

`tsn-topology/` 是已有的独立 skill 仓库，当前存在未提交修改。根目录应用把它作为只读迁移参考，不纳入根 Git 管理，也不会在本 MVP 中修改其中内容。
