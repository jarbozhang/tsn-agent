import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTools, type WorkspaceToolsProps } from "./index";
import { BrowserDiagnosticLogRepository } from "../../../diagnostics/diagnostic-log-repository";
import { createEmptySession } from "../../../sessions/session-repository";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function baseProps(overrides: Partial<WorkspaceToolsProps> = {}): WorkspaceToolsProps {
  const session = createEmptySession();
  return {
    activePanel: undefined,
    setActivePanel: vi.fn(),
    currentSession: session,
    sessions: [session],
    diagnosticsRepository: new BrowserDiagnosticLogRepository(createMemoryStorage()),
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onDuplicateSession: vi.fn(),
    onDeleteSession: vi.fn(),
    backfillFailures: [],
    transferNotice: undefined,
    transferBusy: false,
    payloadView: undefined,
    onExportSession: vi.fn(),
    onImportSession: vi.fn(),
    onViewPayload: vi.fn(),
    onRequestRetry: vi.fn(),
    onRevealExport: vi.fn(),
    onClosePayloadView: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceTools", () => {
  it("renders the tool rail with sessions and settings buttons", () => {
    render(<WorkspaceTools {...baseProps()} />);
    expect(screen.getByRole("button", { name: /会话/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  });

  it("calls setActivePanel when a rail button is clicked", async () => {
    const user = userEvent.setup();
    const setActivePanel = vi.fn();
    render(<WorkspaceTools {...baseProps({ setActivePanel })} />);
    await user.click(screen.getByRole("button", { name: /会话/ }));
    expect(setActivePanel).toHaveBeenCalled();
  });

  it("renders the sessions drawer when activePanel is sessions", () => {
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions" })} />);
    expect(screen.getByRole("button", { name: /新建会话/ })).toBeInTheDocument();
  });

  it("calls onNewSession from the sessions drawer", async () => {
    const user = userEvent.setup();
    const onNewSession = vi.fn();
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions", onNewSession })} />);
    await user.click(screen.getByRole("button", { name: /新建会话/ }));
    expect(onNewSession).toHaveBeenCalled();
  });

  it("renders the settings drawer with the release notes heading", () => {
    render(<WorkspaceTools {...baseProps({ activePanel: "settings" })} />);
    expect(screen.getByText("更新日志")).toBeInTheDocument();
  });

  it("calls onExportSession / onImportSession from the sessions drawer", async () => {
    const user = userEvent.setup();
    const onExportSession = vi.fn();
    const onImportSession = vi.fn();
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions", onExportSession, onImportSession })} />);
    await user.click(screen.getByRole("button", { name: /导出当前/ }));
    expect(onExportSession).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /导入会话/ }));
    expect(onImportSession).toHaveBeenCalled();
  });

  it("disables transfer buttons while the agent is running", () => {
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions", transferBusy: true })} />);
    expect(screen.getByRole("button", { name: /导出当前/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /导入会话/ })).toBeDisabled();
  });

  it("shows a failed badge and recovery area for backfill failures", () => {
    const session = createEmptySession();
    render(
      <WorkspaceTools
        {...baseProps({
          activePanel: "sessions",
          currentSession: session,
          sessions: [session],
          backfillFailures: [
            { sessionId: session.id, state: "failed", errorCode: "PAYLOAD_NOT_JSON", attemptedAt: "2026-06-07T00:00:00Z" },
          ],
        })}
      />,
    );
    expect(screen.getByText("迁移失败")).toBeInTheDocument();
    expect(screen.getByText("待恢复会话")).toBeInTheDocument();
    expect(screen.getByText("原始数据不是合法 JSON")).toBeInTheDocument();
  });

  it("requests retry from the recovery area", async () => {
    const user = userEvent.setup();
    const onRequestRetry = vi.fn();
    const session = createEmptySession();
    render(
      <WorkspaceTools
        {...baseProps({
          activePanel: "sessions",
          backfillFailures: [
            { sessionId: session.id, state: "failed", errorCode: "PAYLOAD_NOT_JSON", attemptedAt: "x" },
          ],
          onRequestRetry,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /重建/ }));
    expect(onRequestRetry).toHaveBeenCalledWith(session.id);
  });
});
