import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const runTsnAgentMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
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

vi.mock("../agent/agent-adapter", () => ({
  runTsnAgent: runTsnAgentMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

describe("App", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    runTsnAgentMock.mockReset();
    invokeMock.mockReset();
    openDialogMock.mockReset();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const { runFakeTsnAgent } = await import("../agent/fake-agent");
    runTsnAgentMock.mockImplementation(
      async ({ userIntent, session }: { userIntent: string; session?: { project?: unknown; workflow?: unknown } }) =>
        runFakeTsnAgent(
          userIntent,
          session?.project as Parameters<typeof runFakeTsnAgent>[1],
          session?.workflow as Parameters<typeof runFakeTsnAgent>[2],
        ),
    );
  });

  it("generates a topology stage and waits for confirmation from a beginner request", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要4个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(screen.getByText("交换机 4")).toBeInTheDocument();
    expect(screen.getByText("端系统 20")).toBeInTheDocument();
    expect(screen.getByText("控制流 0")).toBeInTheDocument();
    expect(screen.getByText(/拓扑等待确认/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.queryByText("控制流-1")).not.toBeInTheDocument();
    expect(screen.getByText("等待 Agent 生成流模板")).toBeInTheDocument();
    expect(screen.getByText("完成“发送规划”阶段后显示导出文件")).toBeInTheDocument();
    expect(screen.getAllByText("tsn-topology")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText("用户提交需求")).toBeInTheDocument();
  });

  it("exposes a project export action after artifacts are generated", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("控制流-1")).toBeInTheDocument();
    expect(screen.getByText("控制流 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("omnetpp.ini")).toBeInTheDocument();
    expect(screen.getByText("INET/OMNeT++ 最小运行配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "选择导出目录" }));
    await user.click(await screen.findByRole("button", { name: "保存" }));

    expect(await screen.findByText(/已导出 5 个文件：browser-preview/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText("项目文件已导出")).toBeInTheDocument();
  });

  it("marks the final planning stage confirmed instead of rerunning it", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText(/发送规划等待确认/)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "确认并继续" }));

    expect(screen.queryByText(/发送规划等待确认/)).not.toBeInTheDocument();
    expect(screen.getByText("omnetpp.ini")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
  });

  it("re-enables submit if pending session persistence fails", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、流模板和导出文件。");
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      if (key === "tsn-agent.sessions.v0") {
        throw new Error("storage failed");
      }

      return originalSetItem.call(window.localStorage, key, value);
    });

    try {
      const button = screen.getByRole("button", { name: /生成规划草案/ });
      await user.click(button);

      expect(button).toBeEnabled();
      expect(await screen.findByText("本次生成失败：storage failed")).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it("falls back to an in-memory initial session if startup persistence fails", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage failed");
    });

    try {
      render(<App />);
      expect(await screen.findByText("告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、流模板和导出文件。")).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not restore a session deleted while the agent is running", async () => {
    const user = userEvent.setup();
    const { runFakeTsnAgent } = await import("../agent/fake-agent");
    const deferred = createDeferred<ReturnType<typeof runFakeTsnAgent>>();
    runTsnAgentMock.mockReturnValue(deferred.promise);

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(screen.getByRole("button", { name: "会话" }));
    await user.click(screen.getByRole("button", { name: /删除当前/ }));

    deferred.resolve(runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统"));

    expect(await screen.findByText("完成“发送规划”阶段后显示导出文件")).toBeInTheDocument();
  });
});
