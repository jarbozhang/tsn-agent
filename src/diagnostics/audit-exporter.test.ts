import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveMock,
}));

import { exportRunAudit } from "./audit-exporter";

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function unmockTauriRuntime() {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("exportRunAudit", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    mockTauriRuntime();
  });

  afterEach(() => {
    unmockTauriRuntime();
  });

  it("throws when called outside the Tauri runtime", async () => {
    unmockTauriRuntime();
    await expect(exportRunAudit({ sessionId: "s", runId: "r" })).rejects.toThrow(/桌面/);
  });

  it("returns cancelled when user dismisses the save dialog", async () => {
    saveMock.mockResolvedValue(null);
    const result = await exportRunAudit({ sessionId: "s", runId: "r" });
    expect(result.kind).toBe("cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes export_run_audit with user-chosen destination and returns the resolved path", async () => {
    saveMock.mockResolvedValue("/tmp/audit.json");
    invokeMock.mockResolvedValue("/tmp/audit.json");
    const result = await exportRunAudit({ sessionId: "session-1", runId: "run-1" });
    expect(saveMock).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("export_run_audit", expect.objectContaining({
      request: expect.objectContaining({
        sessionId: "session-1",
        runId: "run-1",
        destination: "/tmp/audit.json",
      }),
    }));
    expect(result.kind).toBe("exported");
    expect(result.destination).toBe("/tmp/audit.json");
  });

  it("propagates Tauri command rejection as a thrown error", async () => {
    saveMock.mockResolvedValue("/tmp/x.json");
    invokeMock.mockRejectedValue(new Error("路径越界，已拒绝导出 audit"));
    await expect(exportRunAudit({ sessionId: "s", runId: "r" })).rejects.toThrow(/路径越界/);
  });
});
