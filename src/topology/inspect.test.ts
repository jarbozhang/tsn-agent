import { describe, expect, it } from "vitest";
import { initializeTopology } from "./initialize";
import { inspectTopology } from "./inspect";

describe("inspectTopology", () => {
  it("inspects stable ids and adjacency summaries", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const result = inspectTopology({
      topology: initialized.full!.topology,
      selectors: [{ kind: "node", id: "sw1" }],
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.selectedNodeIds).toEqual(["sw1"]);
      expect(result.summary.adjacency).toContainEqual({
        nodeId: "sw1",
        usedPorts: ["p1", "p2"],
        neighborNodeIds: ["es1-1", "sw2"],
      });
      expect(result.full?.portUsage.sw1).toHaveLength(2);
    }
  });

  it("returns ambiguous selector errors without full candidates in summary mode", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const result = inspectTopology({
      topology: initialized.full!.topology,
      selectors: [{ kind: "node", type: "switch" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "AMBIGUOUS_SELECTOR",
        path: "$.selectors[0]",
        requiresUserClarification: true,
        details: { candidateCount: 2 },
      });
    }
  });
});
