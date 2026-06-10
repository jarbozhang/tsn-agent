import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({
    nodes,
    edges,
    onNodeClick,
    onEdgeClick,
  }: {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string }>;
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onEdgeClick?: (event: unknown, edge: { id: string }) => void;
  }) => (
    <div aria-label="拓扑画布">
      {nodes.length} nodes / {edges.length} edges
      {nodes.map((node) => (
        <button key={node.id} type="button" onClick={() => onNodeClick?.({}, node)}>
          选择节点 {node.id}
        </button>
      ))}
      {edges.map((edge) => (
        <button key={edge.id} type="button" onClick={() => onEdgeClick?.({}, edge)}>
          选择链路 {edge.id}
        </button>
      ))}
    </div>
  ),
}));

import { nodeRowLabel, WorkspacePane, type WorkspacePaneProps } from "./index";
import type { TopologyNodeRow, TopologyRowSnapshot } from "../../../sessions/topology-snapshot";

function sampleSnapshot(): TopologyRowSnapshot {
  return {
    sessionId: "s1",
    nodes: [
      { imac: 1, syncName: "0", name: null, x: 0, y: 0, syncType: "{}", nodeType: "switch", insertOrder: 0 },
      { imac: 2, syncName: "1", name: null, x: 160, y: 0, syncType: "{}", nodeType: null, insertOrder: 1 },
    ],
    links: [{ linkSeq: 0, name: "uplink", srcImac: 1, dstImac: 2, stylesJson: "{}" }],
  };
}

function baseProps(overrides: Partial<WorkspacePaneProps> = {}): WorkspacePaneProps {
  return {
    topologySnapshot: undefined,
    selectedTopologyItem: undefined,
    activeConfigTab: "node-detail",
    isAgentRunning: false,
    hasUserInteraction: false,
    onSelectConfigTab: vi.fn(),
    onNodeSelect: vi.fn(),
    onLinkSelect: vi.fn(),
    ...overrides,
  };
}

describe("WorkspacePane", () => {
  it("shows the empty prompt before any interaction", () => {
    render(<WorkspacePane {...baseProps()} />);
    expect(screen.getByText("描述你的 TSN 需求后生成拓扑图")).toBeInTheDocument();
  });

  it("renders the canvas and topology stats when a snapshot is present", () => {
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot() })} />);
    expect(screen.getByText("2 nodes / 1 edges")).toBeInTheDocument();
    const stats = screen.getByLabelText("拓扑统计");
    expect(stats).toHaveTextContent("交换机");
    expect(stats).toHaveTextContent("链路");
  });

  it("calls onNodeSelect when a node is clicked on the canvas", async () => {
    const user = userEvent.setup();
    const onNodeSelect = vi.fn();
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), onNodeSelect })} />);
    await user.click(screen.getByRole("button", { name: "选择节点 1" }));
    expect(onNodeSelect).toHaveBeenCalled();
  });

  it("renders node detail for the selected node", () => {
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          selectedTopologyItem: { kind: "node", id: "1" },
        })}
      />,
    );
    const panel = screen.getByRole("tabpanel", { name: "节点详情" });
    expect(within(panel).getByText("SW-0")).toBeInTheDocument();
    expect(within(panel).getByText("交换机")).toBeInTheDocument();
  });

  it("calls onSelectConfigTab when a config tab is clicked", async () => {
    const user = userEvent.setup();
    const onSelectConfigTab = vi.fn();
    render(<WorkspacePane {...baseProps({ onSelectConfigTab })} />);
    await user.click(screen.getByRole("tab", { name: "链路详情" }));
    expect(onSelectConfigTab).toHaveBeenCalledWith("link-detail");
  });
});

describe("nodeRowLabel", () => {
  function nodeRow(overrides: Partial<TopologyNodeRow> = {}): TopologyNodeRow {
    return {
      imac: 102,
      syncName: "2",
      name: null,
      x: 0,
      y: 0,
      syncType: "{}",
      nodeType: "endSystem",
      insertOrder: 2,
      ...overrides,
    };
  }

  it("画布标签优先用逻辑名，与 agent 对话命名一致", () => {
    // 双平面场景：agent 传 ES-1 而 numericId=2 —— 老逻辑显示 ES-2 与聊天错位。
    expect(nodeRowLabel(nodeRow({ name: "ES-1" }))).toBe("ES-1");
    expect(nodeRowLabel(nodeRow({ name: "SW-1", nodeType: "switch", syncName: "0" }))).toBe("SW-1");
  });

  it("逻辑名缺失（增量节点/历史数据）回退「前缀-同步名」派生", () => {
    expect(nodeRowLabel(nodeRow())).toBe("ES-2");
    expect(nodeRowLabel(nodeRow({ nodeType: "switch", syncName: "0" }))).toBe("SW-0");
  });
});
