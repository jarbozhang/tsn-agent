import { describe, expect, it } from "vitest";
import { initializeTopology } from "./initialize";

describe("initializeTopology", () => {
  it("creates a deterministic generic ring topology", () => {
    const first = initializeTopology({
      templateId: "generic-ring",
      params: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
      responseMode: "full",
    });
    const second = initializeTopology({
      templateId: "generic-ring",
      params: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
      responseMode: "full",
    });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.summary).toEqual({
        templateId: "generic-ring",
        nodeCount: 12,
        linkCount: 12,
        switchCount: 4,
        endSystemCount: 8,
        serverCount: 0,
      });
      expect(first.full?.topology.links.map((link) => [link.source.nodeId, link.target.nodeId])).toContainEqual(["sw4", "sw1"]);
    }
  });

  it("creates a line topology with N-1 switch interconnect links", () => {
    const result = initializeTopology({
      templateId: "generic-line",
      params: {
        switchCount: 3,
        endSystemsPerSwitch: 2,
      },
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.nodeCount).toBe(9);
      expect(result.summary.linkCount).toBe(8);
      expect(result.full?.topology.links.filter((link) =>
        link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
      )).toHaveLength(2);
    }
  });

  it("creates the aerospace redundant 7-networkcard topology", () => {
    const result = initializeTopology({
      templateId: "aerospace-redundant",
      params: { endSystemCount: 7 },
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toMatchObject({
        nodeCount: 11,
        linkCount: 16,
        switchCount: 4,
        endSystemCount: 7,
      });
      expect(result.full?.topology.links.map((link) => [link.source.nodeId, link.source.portId, link.target.nodeId, link.target.portId])).toEqual([
        ["nic1", "p1", "sw1", "p1"],
        ["nic1", "p2", "sw2", "p1"],
        ["nic2", "p1", "sw1", "p2"],
        ["nic2", "p2", "sw2", "p2"],
        ["nic3", "p1", "sw1", "p3"],
        ["nic3", "p2", "sw2", "p3"],
        ["sw1", "p4", "nic4", "p1"],
        ["sw2", "p4", "nic4", "p2"],
        ["sw1", "p5", "nic5", "p1"],
        ["sw2", "p5", "nic5", "p2"],
        ["sw1", "p6", "sw3", "p1"],
        ["sw2", "p6", "sw4", "p1"],
        ["sw3", "p3", "nic6", "p1"],
        ["sw4", "p3", "nic6", "p2"],
        ["sw3", "p4", "nic7", "p1"],
        ["sw4", "p4", "nic7", "p2"],
      ]);
    }
  });

  it("returns structured errors for invalid template params", () => {
    const result = initializeTopology({
      templateId: "generic-line",
      params: {
        switchCount: 99,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "INVALID_TEMPLATE_PARAM",
        path: "$.params.switchCount",
        requiresUserClarification: true,
      });
    }
  });
});
