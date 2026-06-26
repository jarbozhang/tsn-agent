import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HardDeployPanel, type HardDeployPanelProps } from "./hard-deploy-panel";
import type {
  HardwareCheckResult,
  HardwareStartResult,
  HardwareUiState,
  TaskStatusOut,
} from "./hardware-deploy";

const okCheck: HardwareCheckResult = { healthzOk: true, hardwareAvailable: true };
const passStart: HardwareStartResult = {
  taskId: "hw-1",
  validate: { verdict: "PASS", ready: true, taskStartCompatible: true, issues: [] },
  start: { status: "queued", accepted: true },
};

function fakes(over: Partial<HardDeployPanelProps> = {}): HardDeployPanelProps {
  return {
    sessionId: "s1",
    inTimeSyncStage: true,
    treeConfirmed: true,
    hardwareState: { status: "idle" },
    onHardwareStateChange: vi.fn(),
    onGoSoftSim: vi.fn(),
    check: vi.fn(async () => okCheck),
    start: vi.fn(async () => passStart),
    query: vi.fn(async (): Promise<TaskStatusOut> => ({ status: "running" })),
    metrics: vi.fn(async () => ({ series: [] })),
    stop: vi.fn(async (): Promise<TaskStatusOut> => ({ status: "stopped" })),
    ...over,
  };
}

/** 受控 harness：自己持 state，驱动链路推进时 UI 跟随重渲染（贴近真实）。 */
function Harness(props: Partial<HardDeployPanelProps>) {
  const [hw, setHw] = useState<HardwareUiState>({ status: "idle" });
  return (
    <HardDeployPanel {...fakes({ ...props, hardwareState: hw, onHardwareStateChange: setHw })} />
  );
}

describe("HardDeployPanel — gating empty state", () => {
  it("tree not confirmed shows guidance, no start button", () => {
    render(<HardDeployPanel {...fakes({ treeConfirmed: false })} />);
    expect(screen.getByText(/请先确认时钟树/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始硬件部署" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "先用软件仿真验证" })).toBeInTheDocument();
  });
  it("not in time-sync stage shows stage guidance", () => {
    render(<HardDeployPanel {...fakes({ inTimeSyncStage: false })} />);
    expect(screen.getByText(/请先进入时钟同步阶段/)).toBeInTheDocument();
  });
});

describe("HardDeployPanel — button + body per state", () => {
  it("idle: start button + hint", () => {
    render(<HardDeployPanel {...fakes({ hardwareState: { status: "idle" } })} />);
    expect(screen.getByRole("button", { name: "开始硬件部署" })).toBeEnabled();
    expect(screen.getByText(/点上方按钮/)).toBeInTheDocument();
  });
  it("checking: disabled 部署中 button", () => {
    render(<HardDeployPanel {...fakes({ hardwareState: { status: "checking" } })} />);
    expect(screen.getByRole("button", { name: "部署中…" })).toBeDisabled();
  });
  it("observing without metrics: stop button + 采集中", () => {
    render(
      <HardDeployPanel {...fakes({ hardwareState: { status: "observing", taskId: "hw-1" } })} />,
    );
    expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument();
    expect(screen.getByText("采集中…")).toBeInTheDocument();
  });
  it("observing with no_data metrics: 暂无数据", () => {
    render(
      <HardDeployPanel
        {...fakes({
          hardwareState: {
            status: "observing",
            taskId: "hw-1",
            metrics: { metrics_status: "no_data", series: [] },
          },
        })}
      />,
    );
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });
  it("done: 重新部署 + 任务已完成", () => {
    render(<HardDeployPanel {...fakes({ hardwareState: { status: "done" } })} />);
    expect(screen.getByRole("button", { name: "重新部署" })).toBeInTheDocument();
    expect(screen.getByText("任务已完成")).toBeInTheDocument();
  });
  it("stopped: 任务已停止 (distinct from done)", () => {
    render(<HardDeployPanel {...fakes({ hardwareState: { status: "stopped" } })} />);
    expect(screen.getByText("任务已停止")).toBeInTheDocument();
  });
  it("failed: 任务失败 with message", () => {
    render(
      <HardDeployPanel {...fakes({ hardwareState: { status: "failed", message: "设备掉线" } })} />,
    );
    expect(screen.getByText(/任务失败：设备掉线/)).toBeInTheDocument();
  });
  it("error with sync_period issue: 重试 + plain-text issue + sync_period guidance", () => {
    render(
      <HardDeployPanel
        {...fakes({
          hardwareState: {
            status: "error",
            message: "配置校验未通过",
            issues: [
              { severity: "ERROR", code: "bad_sync_period", message: "sync_period 128 不支持" },
            ],
          },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    // issue 以纯文本展示（不经 markdown）。
    expect(screen.getByText("sync_period 128 不支持")).toBeInTheDocument();
    // R1 专门引导。
    expect(screen.getByText(/硬件仅支持同步周期 1000/)).toBeInTheDocument();
  });
});

describe("HardDeployPanel — driver", () => {
  it("check unavailable -> error with reason", async () => {
    const check = vi.fn(async () => ({
      healthzOk: true,
      hardwareAvailable: false,
      reason: "无设备",
    }));
    render(<Harness check={check} />);
    screen.getByRole("button", { name: "开始硬件部署" }).click();
    await waitFor(() => expect(screen.getByText("无设备")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("validate FAIL -> error shows issues, never starts", async () => {
    const start = vi.fn(
      async (): Promise<HardwareStartResult> => ({
        taskId: "hw-1",
        validate: {
          verdict: "FAIL",
          summary: "校验未通过",
          ready: false,
          taskStartCompatible: false,
          issues: [{ severity: "ERROR", message: "拓扑规模不符" }],
        },
      }),
    );
    render(<Harness start={start} />);
    screen.getByRole("button", { name: "开始硬件部署" }).click();
    await waitFor(() => expect(screen.getByText("拓扑规模不符")).toBeInTheDocument());
  });

  it("happy path reaches observing (stop button appears)", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "开始硬件部署" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument(),
    );
  });

  it("stop returning done shows 任务已完成 (not stopped)", async () => {
    const stop = vi.fn(async (): Promise<TaskStatusOut> => ({ status: "done" }));
    render(<Harness stop={stop} />);
    screen.getByRole("button", { name: "开始硬件部署" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument(),
    );
    screen.getByRole("button", { name: "停止任务" }).click();
    await waitFor(() => expect(screen.getByText("任务已完成")).toBeInTheDocument());
  });
});
