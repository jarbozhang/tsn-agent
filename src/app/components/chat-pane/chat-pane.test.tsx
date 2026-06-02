import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AgentRunStatusBar,
  AgentStepSummaryGroup,
  AgentWaitingIndicator,
  LegacyOriginBanner,
  Step,
  getAgentRunStatusMessage,
  stampAgentEvents,
} from "./index";
import type { AgentEvent } from "../../../agent/agent-types";

describe("ChatPane primitives", () => {
  it("Step renders status class", () => {
    render(<Step index="1" label="拓扑" status="confirmed" />);
    expect(screen.getByText("拓扑")).toBeInTheDocument();
  });

  it("AgentWaitingIndicator renders polite status", () => {
    render(<AgentWaitingIndicator />);
    expect(screen.getByText(/正在连接智能助手/)).toBeInTheDocument();
  });

  it("AgentRunStatusBar shows the phase-specific message", () => {
    render(<AgentRunStatusBar elapsedSeconds={5} phase="streaming" />);
    expect(screen.getByText(/智能助手正在持续推理/)).toBeInTheDocument();
    expect(screen.getByText(/已运行 5 秒/)).toBeInTheDocument();
  });

  it("getAgentRunStatusMessage returns specific text per phase", () => {
    expect(getAgentRunStatusMessage("waiting")).toMatch(/可能正在等待工具/);
    expect(getAgentRunStatusMessage("streaming")).toMatch(/正在持续推理/);
    expect(getAgentRunStatusMessage("connecting")).toMatch(/正在连接/);
  });

  it("LegacyOriginBanner calls onAcknowledge when button clicked", async () => {
    const user = userEvent.setup();
    const onAck = vi.fn();
    render(<LegacyOriginBanner onAcknowledge={onAck} />);
    await user.click(screen.getByRole("button", { name: /我知道了/ }));
    expect(onAck).toHaveBeenCalled();
  });

  it("stampAgentEvents stamps id + createdAt deterministically", () => {
    const events = [{ id: "a", createdAt: "old" }, { id: "b" }];
    const out = stampAgentEvents(events, "2026-06-02T00:00:00Z");
    expect(out[0].createdAt).toBe("2026-06-02T00:00:00Z");
    expect(out[0].id).toMatch(/^a-/);
    expect(out[1].id).toMatch(/^b-/);
  });

  it("AgentStepSummaryGroup filters events by runId", () => {
    const events: AgentEvent[] = [
      { id: "e1", runId: "r1", kind: "skill-result", title: "Step A", content: "...", status: "success" },
      { id: "e2", runId: "r2", kind: "skill-result", title: "Step B", content: "...", status: "success" },
    ];
    render(
      <AgentStepSummaryGroup
        runId="r1"
        events={events}
        onToggleExpanded={() => undefined}
      />,
    );
    expect(screen.getByText("Step A")).toBeInTheDocument();
    expect(screen.queryByText("Step B")).not.toBeInTheDocument();
  });
});
