import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children?: unknown }) => children ?? null,
  getSmoothStepPath: () => ["M0 0", 0, 0],
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
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

import {
  nodeRowLabel,
  parseLinkStyles,
  pickHandleSides,
  planeClassName,
  topologySnapshotToReactFlow,
  WorkspacePane,
  type TsnLinkEdgeData,
  type WorkspacePaneProps,
} from "./index";
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

describe("parseLinkStyles（R7 容错）", () => {
  it("解析 plane 与端口标签", () => {
    expect(parseLinkStyles('{"plane":"A","leftLabel":"P0","rightLabel":"P1","speed":1000}')).toEqual({
      plane: "A",
      leftLabel: "P0",
      rightLabel: "P1",
    });
  });

  it("缺失/非法 plane、非 JSON、非对象一律回退空 meta 不抛错", () => {
    expect(parseLinkStyles("{}")).toEqual({});
    expect(parseLinkStyles('{"plane":"C"}')).toEqual({});
    expect(parseLinkStyles('{"plane":1}')).toEqual({});
    expect(parseLinkStyles("not-json")).toEqual({});
    expect(parseLinkStyles("[1,2]")).toEqual({});
    expect(parseLinkStyles("null")).toEqual({});
  });

  it("存量 p1 标签原值透传（AE4：不映射、不过滤）", () => {
    expect(parseLinkStyles('{"leftLabel":"p1","rightLabel":"p2"}')).toEqual({
      leftLabel: "p1",
      rightLabel: "p2",
    });
  });
});

describe("planeClassName（R9）", () => {
  it("三态 className", () => {
    expect(planeClassName("A")).toBe("plane-a");
    expect(planeClassName("B")).toBe("plane-b");
    expect(planeClassName(undefined)).toBe("plane-neutral");
  });
});

describe("pickHandleSides（R10 纯函数）", () => {
  it("跨行一律垂直：上方节点 bottom ↔ 下方节点 top", () => {
    expect(pickHandleSides({ x: 0, y: 0 }, { x: 500, y: 300 })).toEqual({
      source: "bottom",
      target: "top",
    });
    expect(pickHandleSides({ x: 500, y: 300 }, { x: 0, y: 0 })).toEqual({
      source: "top",
      target: "bottom",
    });
  });

  it("同行水平：左 right ↔ 右 left", () => {
    expect(pickHandleSides({ x: 0, y: 100 }, { x: 300, y: 100 })).toEqual({
      source: "right",
      target: "left",
    });
    expect(pickHandleSides({ x: 300, y: 100 }, { x: 0, y: 100 })).toEqual({
      source: "left",
      target: "right",
    });
  });

  it("单跳长距跨行边（ES-1→SW-2）不选水平 handle（防穿行）", () => {
    // |dx| 远大于 |dy| 也必须走垂直——主轴判定会穿过同排节点。
    expect(pickHandleSides({ x: 90, y: 60 }, { x: 420, y: 300 }).source).toBe("bottom");
  });
});

describe("topologySnapshotToReactFlow（U4/U5）", () => {
  function node(imac: number, x: number, y: number): TopologyNodeRow {
    return { imac, syncName: String(imac), name: null, x, y, syncType: "{}", nodeType: imac < 10 ? "switch" : "endSystem", insertOrder: imac };
  }

  it("plane className 三态 + smoothstep 自定义 edge + handle 选边落到 edge 对象", () => {
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 300), node(10, 90, 60)],
      links: [
        { linkSeq: 0, name: null, srcImac: 10, dstImac: 1, stylesJson: '{"plane":"A","leftLabel":"P0","rightLabel":"P0"}' },
        { linkSeq: 1, name: null, srcImac: 10, dstImac: 1, stylesJson: '{"plane":"B"}' },
        { linkSeq: 2, name: null, srcImac: 10, dstImac: 1, stylesJson: "broken" },
      ],
    };
    const { edges } = topologySnapshotToReactFlow(snapshot);
    expect(edges.map((e) => e.className)).toEqual(["plane-a", "plane-b", "plane-neutral"]);
    expect(edges.every((e) => e.type === "tsnLink")).toBe(true);
    // ES(10) 在上、SW(1) 在下：跨行垂直。
    expect(edges[0].sourceHandle).toBe("s-bottom");
    expect(edges[0].targetHandle).toBe("t-top");
    const data0 = edges[0].data as TsnLinkEdgeData;
    expect(data0.leftLabel).toBe("P0");
    expect(data0.rightLabel).toBe("P0");
  });

  it("同 handle 多边 offset 互异且确定性（R12）", () => {
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 300), node(10, 90, 60), node(11, 270, 60)],
      links: [
        { linkSeq: 0, name: null, srcImac: 10, dstImac: 1, stylesJson: "{}" },
        { linkSeq: 1, name: null, srcImac: 11, dstImac: 1, stylesJson: "{}" },
      ],
    };
    const offsets = () =>
      topologySnapshotToReactFlow(snapshot).edges.map((e) => (e.data as TsnLinkEdgeData).offset);
    const first = offsets();
    expect(new Set(first).size).toBe(2);
    expect(offsets()).toEqual(first);
  });

  it("同行共走廊堆叠边带非零 centerYShift 绕行，内侧边直连（KTD）", () => {
    // 双跳左外端堆叠：e-inner(x=-100) 与 e-outer(x=-280) 同行连 SW(x=120)。
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 360), node(10, -100, 360), node(11, -280, 360)],
      links: [
        { linkSeq: 0, name: null, srcImac: 10, dstImac: 1, stylesJson: "{}" },
        { linkSeq: 1, name: null, srcImac: 11, dstImac: 1, stylesJson: "{}" },
      ],
    };
    const { edges } = topologySnapshotToReactFlow(snapshot);
    const inner = edges[0].data as TsnLinkEdgeData;
    const outer = edges[1].data as TsnLinkEdgeData;
    expect(inner.centerYShift).toBe(0);
    expect(outer.centerYShift).toBeGreaterThan(0);
  });
});
