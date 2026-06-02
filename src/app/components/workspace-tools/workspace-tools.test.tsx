import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceToolRail, WorkspaceToolDrawer } from "./index";
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

describe("WorkspaceToolRail", () => {
  it("renders 4 buttons (sessions / diagnostics / skills / settings)", () => {
    render(<WorkspaceToolRail onSelectPanel={() => undefined} />);
    expect(screen.getByRole("button", { name: /会话/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /日志/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Skill/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  });

  it("calls onSelectPanel when clicked", async () => {
    const user = userEvent.setup();
    const onSelectPanel = vi.fn();
    render(<WorkspaceToolRail onSelectPanel={onSelectPanel} />);
    await user.click(screen.getByRole("button", { name: /会话/ }));
    expect(onSelectPanel).toHaveBeenCalledWith("sessions");
  });
});

describe("WorkspaceToolDrawer", () => {
  it("renders SessionToolPanel when activePanel = sessions", () => {
    const session = createEmptySession();
    const diagnostics = new BrowserDiagnosticLogRepository(createMemoryStorage());
    render(
      <WorkspaceToolDrawer
        activePanel="sessions"
        currentSession={session}
        diagnosticsRepository={diagnostics}
        sessions={[session]}
        appVersion="0.2.1"
        onClose={() => undefined}
        onDeleteSession={() => undefined}
        onDuplicateSession={() => undefined}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /新建会话/ })).toBeInTheDocument();
  });

  it("calls onNewSession when new-session button clicked", async () => {
    const user = userEvent.setup();
    const session = createEmptySession();
    const diagnostics = new BrowserDiagnosticLogRepository(createMemoryStorage());
    const onNewSession = vi.fn();
    render(
      <WorkspaceToolDrawer
        activePanel="sessions"
        currentSession={session}
        diagnosticsRepository={diagnostics}
        sessions={[session]}
        appVersion="0.2.1"
        onClose={() => undefined}
        onDeleteSession={() => undefined}
        onDuplicateSession={() => undefined}
        onNewSession={onNewSession}
        onSelectSession={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: /新建会话/ }));
    expect(onNewSession).toHaveBeenCalled();
  });
});
