import { describe, expect, it } from "vitest";
import {
  bundleForAgentResult,
  createPlannerRunToken,
  plannerRunForAgentResult,
} from "./use-planner-run";
import { createProjectFromIntent } from "../../topology/topology-factory";
import { createArtifactBundle } from "../../export/artifact-bundle";
import {
  createPlannerRequestFingerprint,
  type PlannerRunState,
} from "../../planner/planner-contract";
import { exportPlannerInput } from "../../export/planner-exporter";

describe("usePlannerRun helpers", () => {
  it("createPlannerRunToken returns a unique-ish string per call", () => {
    const a = createPlannerRunToken();
    const b = createPlannerRunToken();
    expect(a).toMatch(/^planner-run-/);
    expect(b).toMatch(/^planner-run-/);
    expect(a).not.toBe(b);
  });

  it("plannerRunForAgentResult keeps run when fingerprint matches new project", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
    const current: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: fingerprint,
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: fingerprint,
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = plannerRunForAgentResult(current, project);
    expect(result.status).toBe("succeeded");
    expect(result.requestFingerprint).toBe(fingerprint);
  });

  it("plannerRunForAgentResult marks stale when project changes", () => {
    const projectA = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const projectB = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");
    const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(projectA));
    const current: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: fingerprint,
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: fingerprint,
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = plannerRunForAgentResult(current, projectB);
    expect(result.status).toBe("stale");
  });

  it("plannerRunForAgentResult returns current unchanged if there's no snapshot to invalidate", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const current: PlannerRunState = { status: "idle", baseUrl: "" };
    const result = plannerRunForAgentResult(current, project);
    expect(result).toEqual(current);
  });

  it("bundleForAgentResult rebuilds bundle when fingerprint matches", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
    const bundle = createArtifactBundle(project);
    const run: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: fingerprint,
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: fingerprint,
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = bundleForAgentResult(project, bundle, run);
    expect(result).toBeDefined();
  });

  it("bundleForAgentResult returns original bundle when fingerprint mismatched", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const bundle = createArtifactBundle(project);
    const run: PlannerRunState = {
      status: "succeeded",
      baseUrl: "",
      planId: "p1",
      requestFingerprint: "different-fingerprint",
      resultSnapshot: {
        planId: "p1",
        state: "succeeded",
        requestFingerprint: "different-fingerprint",
        sourceOutputs: {},
        receivedAt: "2026-06-02T00:00:00.000Z",
        summary: { linkCount: 0, gclEntryCount: 0, fingerprintFiles: [] },
      },
    };
    const result = bundleForAgentResult(project, bundle, run);
    expect(result).toBe(bundle);
  });

  it("bundleForAgentResult returns input bundle unchanged when bundle is undefined", () => {
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统");
    const run: PlannerRunState = { status: "idle", baseUrl: "" };
    const result = bundleForAgentResult(project, undefined, run);
    expect(result).toBeUndefined();
  });
});
