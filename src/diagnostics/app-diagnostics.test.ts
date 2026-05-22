import { describe, expect, it, vi } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "../export/artifact-bundle";
import { createEmptySession } from "../sessions/session-repository";
import { artifactBundleSummary, logDiagnostic, sessionSummary, userIntentPreview } from "./app-diagnostics";
import type { DiagnosticLogRepository } from "./diagnostic-log-repository";

describe("app diagnostics helpers", () => {
  it("summarizes sessions without embedding full payloads", () => {
    const session = {
      ...createEmptySession(),
      project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"),
    };

    expect(sessionSummary(session)).toMatchObject({
      title: "新的 TSN 规划",
      messageCount: 1,
      hasProject: true,
      projectName: "当前规划",
    });
  });

  it("summarizes artifact paths and sizes", () => {
    const bundle = createArtifactBundle(createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"));

    expect(artifactBundleSummary(bundle).files.map((file) => file.path)).toEqual([
      "simulation/inet/tsnagent/generated/network.ned",
      "simulation/inet/omnetpp.ini",
      "simulation/inet/traffic.ini",
      "workspace/react-flow-topology.json",
      "planner/flow_plan_1.json",
      "manifest.json",
    ]);
    expect(artifactBundleSummary(bundle).files[1]).toMatchObject({
      group: "simulation-inet",
      isEntrypoint: true,
      roleLabel: "INET 入口",
    });
    expect(artifactBundleSummary(bundle).files[0].contentLength).toBeGreaterThan(0);
  });

  it("redacts user intent previews", () => {
    expect(userIntentPreview("api_key=sk-ant-secret 我需要4个交换机").preview).not.toContain("sk-ant-secret");
  });

  it("logs best-effort without awaiting callers", () => {
    const append = vi.fn(async () => undefined);
    const repository: DiagnosticLogRepository = {
      append,
      list: vi.fn(),
      clearSession: vi.fn(),
    };

    logDiagnostic(repository, { sessionId: "session-1", category: "session", message: "保存会话" });

    expect(append).toHaveBeenCalledWith({ sessionId: "session-1", category: "session", message: "保存会话" });
  });
});
