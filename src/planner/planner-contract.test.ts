import { describe, expect, it } from "vitest";
import {
  createIdlePlannerRunState,
  isTerminalPlannerState,
  normalizePlannerRunState,
  PLANNER_SERVICE_DEFAULT_BASE_URL,
  type PlannerStartRequest,
  resolvePlannerBaseUrl,
  summarizePlannerRequest,
  summarizePlannerResult,
} from "./planner-contract";

describe("planner contract", () => {
  it("resolves planner base URL with the configured default", () => {
    expect(resolvePlannerBaseUrl()).toBe(PLANNER_SERVICE_DEFAULT_BASE_URL);
    expect(resolvePlannerBaseUrl("  http://planner.local:18080/  ")).toBe(
      "http://planner.local:18080",
    );
  });

  it("normalizes missing planner run state to idle", () => {
    expect(normalizePlannerRunState(undefined)).toEqual(createIdlePlannerRunState());
  });

  it("preserves persisted running state with safe defaults", () => {
    expect(
      normalizePlannerRunState({
        status: "running",
        baseUrl: " http://planner.local:18080/ ",
        planId: "plan-1",
        runningDurationMs: 1200,
        requestSummary: {
          mode: "time-trigger",
          nodeCount: 2,
          linkCount: 1,
          flowCount: 1,
          streamIds: [1],
        },
      }),
    ).toMatchObject({
      status: "running",
      baseUrl: "http://planner.local:18080",
      planId: "plan-1",
      runningDurationMs: 1200,
      requestSummary: {
        nodeCount: 2,
        linkCount: 1,
        flowCount: 1,
        streamIds: [1],
      },
    });
  });

  it("summarizes request and result without storing full payloads in run state", () => {
    const request: PlannerStartRequest = {
      sendData: {
        mode: "time-trigger",
        source_config: {
          cfg_parameter: {
            cfg_parameter: { node: [{ node_id: "0" } as never, { node_id: "1" } as never] },
          },
          flow_feature: [{ stream_id: 7 } as never],
          topo_feature: [{ link_id: 0 } as never],
        },
      },
    };

    expect(summarizePlannerRequest(request)).toEqual({
      mode: "time-trigger",
      nodeCount: 2,
      linkCount: 1,
      flowCount: 1,
      streamIds: [7],
    });
    expect(
      summarizePlannerResult(
        {
          solution_json: [
            { link_id: 0, gcl_entries: [{ interval: 10 }, { interval: 20 }] },
            { link_id: 1, gcl_entries: [] },
          ],
        },
        {
          solution_json: {
            file_name: "solution.json",
            size_bytes: 128,
            sha256: "a".repeat(64),
            mtime_ns: 1,
          },
        },
      ),
    ).toEqual({
      linkCount: 2,
      gclEntryCount: 2,
      fingerprintFiles: ["solution.json"],
    });
  });

  it("identifies terminal planner states", () => {
    expect(isTerminalPlannerState("succeeded")).toBe(true);
    expect(isTerminalPlannerState("failed")).toBe(true);
    expect(isTerminalPlannerState("running")).toBe(false);
    expect(isTerminalPlannerState("busy")).toBe(false);
  });
});
