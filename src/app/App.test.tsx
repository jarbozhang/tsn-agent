import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  MarkerType: {
    ArrowClosed: "arrowclosed",
  },
  Position: {
    Left: "left",
    Right: "right",
  },
  ReactFlow: ({ nodes, edges }: { nodes: unknown[]; edges: unknown[] }) => (
    <div aria-label="拓扑画布">
      {nodes.length} nodes / {edges.length} edges
    </div>
  ),
}));

describe("App", () => {
  it("generates the MVP artifacts from a beginner request", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要4个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(screen.getByText("交换机 4")).toBeInTheDocument();
    expect(screen.getByText("端系统 20")).toBeInTheDocument();
    expect(screen.getByText("network.ned")).toBeInTheDocument();
    expect(screen.getAllByText("tsn-topology")).toHaveLength(2);
  });
});
