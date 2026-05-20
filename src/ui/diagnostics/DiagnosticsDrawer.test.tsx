import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsLogView } from "./DiagnosticsDrawer";
import type { DiagnosticLogEntry } from "../../diagnostics/diagnostic-log";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";

function createRepository(overrides: Partial<DiagnosticLogRepository> = {}): DiagnosticLogRepository {
  const logs: DiagnosticLogEntry[] = [
    {
      id: "log-1",
      sessionId: "session-1",
      category: "agent",
      level: "info",
      message: "Claude Agent 请求完成",
      createdAt: "2026-05-20T00:00:00.000Z",
      runId: "run-1",
      durationMs: 123,
      details: { mode: "claude" },
    },
    {
      id: "log-2",
      sessionId: "session-1",
      category: "artifact",
      level: "info",
      message: "artifact bundle 已生成",
      createdAt: "2026-05-20T00:00:01.000Z",
    },
  ];

  return {
    append: vi.fn(),
    clearSession: vi.fn(),
    list: vi.fn(async () => logs),
    ...overrides,
  };
}

describe("DiagnosticsLogView", () => {
  it("loads and renders current session logs", async () => {
    render(<DiagnosticsLogView sessionId="session-1" repository={createRepository()} />);

    expect(await screen.findByText("Claude Agent 请求完成")).toBeInTheDocument();
    expect(screen.getByText("artifact bundle 已生成")).toBeInTheDocument();
    expect(screen.getByText("run=run-1")).toBeInTheDocument();
  });

  it("filters logs by category", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsLogView sessionId="session-1" repository={createRepository()} />);

    await screen.findByText("Claude Agent 请求完成");
    await user.click(screen.getByRole("button", { name: "文件" }));

    expect(screen.queryByText("Claude Agent 请求完成")).not.toBeInTheDocument();
    expect(screen.getByText("artifact bundle 已生成")).toBeInTheDocument();
  });

  it("shows an error state when loading fails", async () => {
    render(<DiagnosticsLogView sessionId="session-1" repository={createRepository({ list: vi.fn(async () => {
      throw new Error("database failed");
    }) })} />);

    expect(await screen.findByText("日志加载失败：database failed")).toBeInTheDocument();
  });
});
