import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReactFlowProvider } from "@xyflow/react";
import {
  PlannerTaskPanel,
  TsnTopologyNode,
  artifactGroupFallbackLabels,
  findPortIndex,
  groupArtifacts,
} from "./index";
import type { ExportedArtifact } from "../../../export/artifact-bundle";
import type { PlannerRunState } from "../../../planner/planner-contract";

function renderTopologyNode(props: Parameters<typeof TsnTopologyNode>[0]) {
  return render(
    <ReactFlowProvider>
      <TsnTopologyNode {...props} />
    </ReactFlowProvider>,
  );
}

function basePlannerRun(overrides: Partial<PlannerRunState> = {}): PlannerRunState {
  return {
    status: "idle",
    baseUrl: "http://localhost:8000",
    ...overrides,
  };
}

describe("workspace-pane helpers", () => {
  it("findPortIndex returns index when port exists", () => {
    const node = { ports: [{ id: "p1", index: 0 }, { id: "p2", index: 1 }] };
    expect(findPortIndex(node, "p2")).toBe(1);
  });

  it("findPortIndex returns 无 when port absent", () => {
    expect(findPortIndex({ ports: [] }, "p1")).toBe("无");
  });

  it("groupArtifacts returns empty array when no artifacts", () => {
    expect(groupArtifacts([])).toEqual([]);
  });

  it("groupArtifacts groups by classification.group", () => {
    const artifacts: ExportedArtifact[] = [
      { path: "workspace/file.json", content: "{}", label: "Workspace 1", purpose: "ned-template" } as unknown as ExportedArtifact,
    ];
    const groups = groupArtifacts(artifacts);
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  it("artifactGroupFallbackLabels covers all groups", () => {
    expect(artifactGroupFallbackLabels.workspace).toBeDefined();
    expect(artifactGroupFallbackLabels.planner).toBeDefined();
    expect(artifactGroupFallbackLabels["simulation-inet"]).toBeDefined();
    expect(artifactGroupFallbackLabels.manifest).toBeDefined();
    expect(artifactGroupFallbackLabels.legacy).toBeDefined();
  });
});

describe("TsnTopologyNode", () => {
  it("renders SW label and port count for switch nodes", () => {
    renderTopologyNode({
      data: { label: "SW-1", nodeType: "switch", portCount: 4 },
    } as unknown as Parameters<typeof TsnTopologyNode>[0]);
    expect(screen.getByText("SW")).toBeInTheDocument();
    expect(screen.getByText("SW-1")).toBeInTheDocument();
    expect(screen.getByText(/4 ports/)).toBeInTheDocument();
  });

  it("renders ES label and IP for end system nodes", () => {
    renderTopologyNode({
      data: { label: "ES-1-1", nodeType: "endSystem", ipAddress: "10.0.0.5" },
    } as unknown as Parameters<typeof TsnTopologyNode>[0]);
    expect(screen.getByText("ES")).toBeInTheDocument();
    expect(screen.getByText("ES-1-1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5")).toBeInTheDocument();
  });

  it("defaults to endSystem rendering when nodeType is missing", () => {
    renderTopologyNode({
      data: { label: "Unknown" },
    } as unknown as Parameters<typeof TsnTopologyNode>[0]);
    expect(screen.getByText("ES")).toBeInTheDocument();
  });
});

describe("PlannerTaskPanel", () => {
  it("renders idle status + disabled stop button when not running", () => {
    render(
      <PlannerTaskPanel
        plannerRun={basePlannerRun()}
        baseUrl="http://localhost:8000"
        canStart
        canStop={false}
        isActionRunning={false}
        onBaseUrlChange={() => undefined}
        onStart={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(screen.getByText(/规划任务/)).toBeInTheDocument();
    // status badge + task-id detail row both render "未提交"; the form-level
    // status indicator is what matters here.
    expect(screen.getAllByText("未提交").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /启动规划/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /停止/ })).toBeDisabled();
  });

  it("calls onStart when start button is clicked", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(
      <PlannerTaskPanel
        plannerRun={basePlannerRun()}
        baseUrl="http://localhost:8000"
        canStart
        canStop={false}
        isActionRunning={false}
        onBaseUrlChange={() => undefined}
        onStart={onStart}
        onStop={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: /启动规划/ }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("calls onStop when running and stop is clicked", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <PlannerTaskPanel
        plannerRun={basePlannerRun({ status: "running", planId: "p1" })}
        baseUrl="http://localhost:8000"
        canStart={false}
        canStop
        isActionRunning={false}
        onBaseUrlChange={() => undefined}
        onStart={() => undefined}
        onStop={onStop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /停止/ }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables the base URL input while running", () => {
    render(
      <PlannerTaskPanel
        plannerRun={basePlannerRun({ status: "running" })}
        baseUrl="http://localhost:8000"
        canStart={false}
        canStop
        isActionRunning={false}
        onBaseUrlChange={() => undefined}
        onStart={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(screen.getByLabelText("服务地址")).toBeDisabled();
  });

  it("renders errorMessage when present", () => {
    render(
      <PlannerTaskPanel
        plannerRun={basePlannerRun({ status: "failed", errorMessage: "服务返回 500" })}
        baseUrl="http://localhost:8000"
        canStart={false}
        canStop={false}
        isActionRunning={false}
        onBaseUrlChange={() => undefined}
        onStart={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("服务返回 500");
  });

  it("propagates baseUrl edits via onBaseUrlChange", async () => {
    const user = userEvent.setup();
    const onBaseUrlChange = vi.fn();
    render(
      <PlannerTaskPanel
        plannerRun={basePlannerRun()}
        baseUrl="http://localhost:8000"
        canStart
        canStop={false}
        isActionRunning={false}
        onBaseUrlChange={onBaseUrlChange}
        onStart={() => undefined}
        onStop={() => undefined}
      />,
    );
    await user.type(screen.getByLabelText("服务地址"), "/v2");
    expect(onBaseUrlChange).toHaveBeenCalled();
  });
});
