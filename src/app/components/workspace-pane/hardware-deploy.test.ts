import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  type HardwareStartResult,
  type HardwareUiState,
  nextHardwareState,
} from "./hardware-deploy";

describe("classifyStatus", () => {
  it("maps created to transient (not error)", () => {
    expect(classifyStatus("created")).toBe("transient");
  });
  it("maps queued/running to active", () => {
    expect(classifyStatus("queued")).toBe("active");
    expect(classifyStatus("running")).toBe("active");
  });
  it("maps done/stopped to their own classes", () => {
    expect(classifyStatus("done")).toBe("done");
    expect(classifyStatus("stopped")).toBe("stopped");
  });
  it("maps failed/timeout to failed", () => {
    expect(classifyStatus("failed")).toBe("failed");
    expect(classifyStatus("timeout")).toBe("failed");
  });
  it("treats unknown status as active (defensive)", () => {
    expect(classifyStatus("weird")).toBe("active");
  });
});

const startAccepted: HardwareStartResult = {
  taskId: "hw-1",
  validate: { verdict: "PASS", ready: true, taskStartCompatible: true, issues: [] },
  start: { status: "queued", accepted: true },
};

describe("nextHardwareState — begin/checking/starting", () => {
  it("begin from idle goes to checking", () => {
    expect(nextHardwareState({ status: "idle" }, { kind: "begin" })).toEqual({
      status: "checking",
    });
  });
  it("begin from observing is a no-op (cannot restart mid-run)", () => {
    const obs: HardwareUiState = { status: "observing", taskId: "hw-1" };
    expect(nextHardwareState(obs, { kind: "begin" })).toBe(obs);
  });
  it("checked available -> starting", () => {
    expect(
      nextHardwareState(
        { status: "checking" },
        { kind: "checked", result: { healthzOk: true, hardwareAvailable: true } },
      ),
    ).toEqual({ status: "starting" });
  });
  it("checked unavailable -> error with reason", () => {
    const next = nextHardwareState(
      { status: "checking" },
      { kind: "checked", result: { healthzOk: true, hardwareAvailable: false, reason: "无设备" } },
    );
    expect(next).toEqual({ status: "error", message: "无设备" });
  });
});

describe("nextHardwareState — started", () => {
  it("validate gate failed (start undefined) -> error carrying issues", () => {
    const next = nextHardwareState(
      { status: "starting" },
      {
        kind: "started",
        result: {
          taskId: "hw-1",
          validate: {
            verdict: "FAIL",
            summary: "sync_period 不支持",
            ready: false,
            taskStartCompatible: false,
            issues: [{ severity: "ERROR", message: "sync_period 128 不支持" }],
          },
        },
      },
    );
    expect(next.status).toBe("error");
    if (next.status === "error") {
      expect(next.issues).toHaveLength(1);
      expect(next.message).toContain("sync_period");
    }
  });
  it("accepted -> confirming with taskId", () => {
    expect(
      nextHardwareState({ status: "starting" }, { kind: "started", result: startAccepted }),
    ).toEqual({ status: "confirming", taskId: "hw-1" });
  });
  it("not accepted -> error", () => {
    const next = nextHardwareState(
      { status: "starting" },
      {
        kind: "started",
        result: { ...startAccepted, start: { status: "failed", accepted: false } },
      },
    );
    expect(next.status).toBe("error");
  });
});

describe("nextHardwareState — confirming (created retry is the key fix)", () => {
  it("created keeps confirming (does NOT error)", () => {
    const confirming: HardwareUiState = { status: "confirming", taskId: "hw-1" };
    expect(nextHardwareState(confirming, { kind: "queried", result: { status: "created" } })).toBe(
      confirming,
    );
  });
  it("running -> observing", () => {
    expect(
      nextHardwareState(
        { status: "confirming", taskId: "hw-1" },
        { kind: "queried", result: { status: "running" } },
      ),
    ).toEqual({ status: "observing", taskId: "hw-1" });
  });
  it("done -> done; failed -> failed", () => {
    expect(
      nextHardwareState(
        { status: "confirming", taskId: "hw-1" },
        { kind: "queried", result: { status: "done" } },
      ).status,
    ).toBe("done");
    expect(
      nextHardwareState(
        { status: "confirming", taskId: "hw-1" },
        { kind: "queried", result: { status: "timeout" } },
      ).status,
    ).toBe("failed");
  });
});

describe("nextHardwareState — observing", () => {
  it("metrics updates the payload", () => {
    const next = nextHardwareState(
      { status: "observing", taskId: "hw-1" },
      { kind: "metrics", payload: { series: [] } },
    );
    expect(next).toEqual({ status: "observing", taskId: "hw-1", metrics: { series: [] } });
  });
  it("query done -> done, preserving last metrics", () => {
    const next = nextHardwareState(
      { status: "observing", taskId: "hw-1", metrics: { series: [{ node_id: "2" }] } },
      { kind: "queried", result: { status: "done" } },
    );
    expect(next.status).toBe("done");
    if (next.status === "done") {
      expect(next.metrics).toEqual({ series: [{ node_id: "2" }] });
    }
  });
  it("query running stays observing", () => {
    const obs: HardwareUiState = { status: "observing", taskId: "hw-1" };
    expect(nextHardwareState(obs, { kind: "queried", result: { status: "running" } })).toBe(obs);
  });
});

describe("nextHardwareState — stopBegin/stopResult（先进停止中过渡态，再按 status 分流）", () => {
  it("observing + stopBegin -> stopping（保留 metrics）", () => {
    const next = nextHardwareState(
      { status: "observing", taskId: "hw-1", metrics: { series: [{ node_id: "1" }] } },
      { kind: "stopBegin" },
    );
    expect(next.status).toBe("stopping");
    if (next.status === "stopping") {
      expect(next.metrics).toEqual({ series: [{ node_id: "1" }] });
    }
  });
  it("stopResult 只从 stopping 生效（observing 直接 stopResult 不变）", () => {
    const obs: HardwareUiState = { status: "observing", taskId: "hw-1" };
    expect(nextHardwareState(obs, { kind: "stopResult", result: { status: "stopped" } })).toBe(obs);
  });
  it("stop returns stopped -> stopped", () => {
    expect(
      nextHardwareState(
        { status: "stopping" },
        { kind: "stopResult", result: { status: "stopped" } },
      ).status,
    ).toBe("stopped");
  });
  it("stop returns done (task finished concurrently) -> done", () => {
    expect(
      nextHardwareState({ status: "stopping" }, { kind: "stopResult", result: { status: "done" } })
        .status,
    ).toBe("done");
  });
  it("stop returns timeout -> failed", () => {
    expect(
      nextHardwareState(
        { status: "stopping" },
        { kind: "stopResult", result: { status: "timeout" } },
      ).status,
    ).toBe("failed");
  });
});

describe("nextHardwareState — softTimeout", () => {
  it("observing + softTimeout -> stopped, preserving metrics", () => {
    const next = nextHardwareState(
      { status: "observing", taskId: "hw-1", metrics: { series: [] } },
      { kind: "softTimeout" },
    );
    expect(next).toEqual({ status: "stopped", metrics: { series: [] } });
  });
  it("softTimeout outside observing is a no-op", () => {
    const done: HardwareUiState = { status: "done" };
    expect(nextHardwareState(done, { kind: "softTimeout" })).toBe(done);
  });
});

describe("nextHardwareState — error + reset", () => {
  it("failed event -> error with message", () => {
    expect(
      nextHardwareState({ status: "checking" }, { kind: "failed", message: "网络断了" }),
    ).toEqual({ status: "error", message: "网络断了" });
  });
  it("terminal + reset -> idle (retry path)", () => {
    expect(nextHardwareState({ status: "error", message: "x" }, { kind: "reset" })).toEqual({
      status: "idle",
    });
    expect(nextHardwareState({ status: "done" }, { kind: "reset" })).toEqual({ status: "idle" });
  });
});
