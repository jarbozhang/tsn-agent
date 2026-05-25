import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANNER_SERVICE_DEFAULT_BASE_URL, type PlannerStartRequest } from "./planner-contract";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("planner client", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("fails clearly outside the desktop runtime", async () => {
    const { startPlannerPlan } = await import("./planner-client");

    await expect(startPlannerPlan({ request: createPlannerRequest() })).rejects.toThrow("桌面运行时");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("starts a planner task through the Tauri command boundary", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      err_code: 0,
      err_msg: "规划任务已启动",
      data: { state: "running", plan_id: "plan-1" },
    });
    const { startPlannerPlan } = await import("./planner-client");
    const request = createPlannerRequest();

    await expect(startPlannerPlan({ baseUrl: " http://planner.local:18080/ ", request })).resolves.toMatchObject({
      data: { plan_id: "plan-1" },
    });
    expect(invokeMock).toHaveBeenCalledWith("planner_start_plan", {
      request: {
        baseUrl: "http://planner.local:18080",
        payload: request,
      },
    });
  });

  it("queries, reads result, and stops by plan id", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({ err_code: 0, err_msg: "ok", data: { state: "running" } });
    const { getPlannerPlanResult, queryPlannerPlanStatus, stopPlannerPlan } = await import("./planner-client");

    await queryPlannerPlanStatus({ planId: " plan-1 " });
    await getPlannerPlanResult({ planId: "plan-1" });
    await stopPlannerPlan({ planId: "plan-1" });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "planner_query_plan_status", {
      request: {
        baseUrl: PLANNER_SERVICE_DEFAULT_BASE_URL,
        payload: { sendData: { plan_id: "plan-1" } },
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "planner_get_plan_result", {
      request: {
        baseUrl: PLANNER_SERVICE_DEFAULT_BASE_URL,
        payload: { sendData: { plan_id: "plan-1" } },
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "planner_stop_plan", {
      request: {
        baseUrl: PLANNER_SERVICE_DEFAULT_BASE_URL,
        payload: { sendData: { plan_id: "plan-1" } },
      },
    });
  });

  it("rejects empty plan ids before invoking the command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const { queryPlannerPlanStatus } = await import("./planner-client");

    await expect(queryPlannerPlanStatus({ planId: " " })).rejects.toThrow("规划任务 ID 不能为空");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

function createPlannerRequest(): PlannerStartRequest {
  return {
    sendData: {
      mode: "time-trigger",
      source_config: {
        cfg_parameter: { cfg_parameter: { node: [] } },
        flow_feature: [],
        topo_feature: [],
      },
    },
  };
}
