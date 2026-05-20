# 测试说明

TSN Agent MVP 的默认测试只验证新手纵向闭环和本地确定性导出，不依赖真实 Claude 凭证、真实规划器或本机 INET 仿真工具。

## 默认测试

```bash
npm test
npm run build
npm run e2e
npm run cargo:test
```

- `npm test`：运行 Vitest，覆盖 canonical 拓扑、NED/最小 `omnetpp.ini`/React Flow/规划器导出、项目快照、安全写盘、会话持久化、诊断日志、fake agent 和关键 React 行为。
- `npm run build`：执行 TypeScript 类型检查和 Vite 生产构建。
- `npm run e2e`：运行 Web smoke E2E，使用 fake agent 验证一句话拓扑输入、拓扑展示、导出文件列表、保存入口和诊断日志。
- `npm run cargo:test`：运行 Tauri/Rust 单元测试，覆盖会话数据库 schema、诊断日志和 Claude bridge 的基础安全校验。

## 当前不进默认测试

- 真实 Claude Agent SDK 流式输出。
- 桌面壳自动化和 `tauri-driver`。
- 真实 INET/OMNeT++ 编译或仿真不进入默认 CI；当前可在 devserver 上手动运行。
- Tauri 桌面文件选择器；当前 Tauri 写盘 command 由 Rust 单元测试覆盖，Web E2E 只验证保存入口状态。
- gate schedule configurator、GCL/TAS 回写和完整业务流应用配置。
- 外置规划器执行和 `flow_plan_result_1.json` 内容解析。

这些内容属于 hardening 或后续专门 skill 的验收范围。MVP 只要求 `flow_plan_result_1.json` 在外部存在时能被识别为 `planner-output` / `observedExternal`，不由默认导出生成。

## INET 手动验证

devserver 上已安装 INET 4.6.0 / OMNeT++ 6.4.0，可用导出目录执行：

```bash
cd <export-dir>
/home/zhang/.local/bin/inet -u Cmdenv -f omnetpp.ini -n .
```

当前 smoke 验证目录为 `/home/zhang/tsn-agent-inet-verify`，结果能加载 `tsnagent.generated.TsnAgentNetwork` 并运行到 `sim-time-limit`。
