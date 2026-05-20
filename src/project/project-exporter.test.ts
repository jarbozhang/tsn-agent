import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "../export/artifact-bundle";

const invokeMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
}));

describe("exportProjectBundle", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    openDialogMock.mockReset();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("returns a browser preview result outside Tauri", async () => {
    const { exportProjectBundle } = await import("./project-exporter");
    const bundle = createArtifactBundle(createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"));

    await expect(exportProjectBundle(bundle, "/ignored-in-browser")).resolves.toEqual({
      mode: "browser-preview",
      outputDir: "browser-preview",
      writtenFiles: [
        "tsnagent/generated/network.ned",
        "omnetpp.ini",
        "react-flow-topology.json",
        "flow_plan_1.json",
        "manifest.json",
      ],
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("writes artifacts through the Tauri command boundary", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      outputDir: "/tmp/tsn-project",
      writtenFiles: ["tsnagent/generated/network.ned", "omnetpp.ini", "manifest.json"],
    });
    const { exportProjectBundle } = await import("./project-exporter");
    const bundle = createArtifactBundle(createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"));

    const result = await exportProjectBundle(bundle, "/tmp/tsn-project");

    expect(result.mode).toBe("tauri");
    expect(invokeMock).toHaveBeenCalledWith("write_project_artifacts", {
      request: {
        outputDir: "/tmp/tsn-project",
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "tsnagent/generated/network.ned",
            purpose: "simulation-inet",
            label: "INET/OMNeT++ 网络拓扑",
          }),
          expect.objectContaining({
            path: "omnetpp.ini",
            purpose: "simulation-inet",
            label: "INET/OMNeT++ 最小运行配置",
          }),
        ]),
      },
    });
  });

  it("requires an explicit absolute directory in Tauri", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const { exportProjectBundle } = await import("./project-exporter");
    const bundle = createArtifactBundle(createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"));

    await expect(exportProjectBundle(bundle)).rejects.toThrow("绝对项目目录");
  });

  it("loads a suggested directory through the Tauri command boundary", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue("/Users/test/Documents/TSN Agent/session-1");
    const { suggestProjectExportDirectory } = await import("./project-exporter");

    await expect(suggestProjectExportDirectory({ sessionId: "session-1" })).resolves.toBe(
      "/Users/test/Documents/TSN Agent/session-1",
    );
    expect(invokeMock).toHaveBeenCalledWith("suggest_project_export_dir", {
      request: {
        sessionId: "session-1",
      },
    });
  });

  it("selects a directory through the Tauri dialog plugin", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    openDialogMock.mockResolvedValue("/Users/test/Documents/TSN Agent/session-1");
    const { selectProjectExportDirectory } = await import("./project-exporter");

    await expect(selectProjectExportDirectory("/Users/test/Documents")).resolves.toBe(
      "/Users/test/Documents/TSN Agent/session-1",
    );
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      title: "选择 TSN Agent 导出目录",
      defaultPath: "/Users/test/Documents",
    });
  });

  it("opens the exported directory through the opener plugin", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const { openProjectExportDirectory } = await import("./project-exporter");

    await openProjectExportDirectory("/Users/test/Documents/TSN Agent/session-1");

    expect(invokeMock).toHaveBeenCalledWith("open_project_export_dir", {
      request: {
        outputDir: "/Users/test/Documents/TSN Agent/session-1",
      },
    });
  });
});
