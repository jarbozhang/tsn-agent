import { describe, expect, it } from "vitest";
import { parseChangelog } from "./release-info";

describe("release info", () => {
  it("parses customer-visible release notes and hides internal categories", () => {
    const releases = parseChangelog(`# 更新日志

## v0.2.1 - 2026-05-26

### 新功能

- 接入规划服务工作流（dfa4d68）

### 工程与构建

- 调整 CI 触发规则（8077082）

### 测试

- 稳定 planner retry assertion（dfa4d68）

### 修复

- 优化规划任务轮询逻辑
`);

    expect(releases).toEqual([
      {
        version: "0.2.1",
        date: "2026-05-26",
        categories: [
          {
            title: "新功能",
            items: ["接入规划服务工作流"],
          },
          {
            title: "修复",
            items: ["优化规划任务轮询逻辑"],
          },
        ],
      },
    ]);
  });
});
