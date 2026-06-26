import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildTimeSyncNodeMetrics,
  type TimeSyncMetricsQueryResponse,
  TimeSyncOffsetChart,
} from "./time-sync-offset-chart";

const echartsMock = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("echarts", () => ({
  init: vi.fn(() => echartsMock),
}));

function sampleMetrics(): TimeSyncMetricsQueryResponse {
  return {
    task_id: "time-sync-task-1",
    metric: "time_sync",
    metrics_status: "ready",
    mode: "series",
    source: "simulation",
    runs: [{ threshold_ns: 1000, sample_count: 3, status: "ready" }],
    series: [
      {
        node_id: "1",
        label: "GM-1",
        points: [
          {
            bucket_start_ns: 0,
            latest_offset_ns: 0,
            avg_offset_ns: 0,
            max_abs_offset_ns: 0,
          },
        ],
      },
      {
        node_id: "2",
        label: "ES-2",
        points: [
          {
            bucket_start_ns: 0,
            latest_offset_ns: 4,
            avg_offset_ns: 3,
            max_abs_offset_ns: 40,
          },
          {
            bucket_start_ns: 10_000_000,
            latest_offset_ns: -8,
            avg_offset_ns: -6,
            max_abs_offset_ns: 120,
          },
          {
            bucket_start_ns: 20_000_000,
            latest_offset_ns: 12,
            avg_offset_ns: 9,
            max_abs_offset_ns: 320,
          },
        ],
      },
    ],
  };
}

describe("TimeSyncOffsetChart", () => {
  it("使用最新、平均、最大绝对偏差计算曲线范围，并展示 dataZoom 与周期信息", async () => {
    echartsMock.setOption.mockClear();

    render(
      <TimeSyncOffsetChart
        metrics={sampleMetrics()}
        masterNodeId="1"
        masterLabel="GM-1"
        syncPeriodLabel="125 ms"
        measurePeriodLabel="1024 ms"
      />,
    );

    expect(screen.getByText("时钟同步周期")).toBeInTheDocument();
    expect(screen.getByText("125 ms")).toBeInTheDocument();
    expect(screen.getByText("链路测量周期")).toBeInTheDocument();
    expect(screen.getByText("1024 ms")).toBeInTheDocument();
    expect(screen.queryByText("最新最大偏差")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "时钟偏移曲线图" })).toBeInTheDocument();

    await waitFor(() => expect(echartsMock.setOption).toHaveBeenCalled());

    const option = echartsMock.setOption.mock.calls.at(-1)?.[0] as {
      dataZoom: Array<{ type: string }>;
      series: Array<{ data: Array<number | null> }>;
      yAxis: { min: number; max: number; interval: number };
    };
    expect(option.dataZoom.map((item) => item.type)).toEqual(["inside", "slider"]);
    expect(option.series[2]?.data).toEqual([4, -8, 12]);
    expect(option.yAxis).toMatchObject({ min: -500, max: 500, interval: 250 });
  });

  it("节点汇总指标只从 offset 字段归一化，不依赖接口请求逻辑", () => {
    const metrics = buildTimeSyncNodeMetrics(sampleMetrics());

    expect(metrics["2"]).toMatchObject({
      hasSamples: true,
      currentOffsetNs: 12,
      maxOffsetNs: 12,
      minOffsetNs: -8,
      maxAbsOffsetNs: 12,
      thresholdExceedCount: 0,
    });
  });
});
