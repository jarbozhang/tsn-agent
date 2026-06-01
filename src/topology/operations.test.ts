import { describe, expect, it } from "vitest";
import { createPorts, type IntermediateNode } from "./intermediate";
import { initializeTopology } from "./initialize";
import { applyTopologyOperations, type TopologyOperation } from "./operations";

describe("applyTopologyOperations", () => {
  it("dry-runs and applies the insert-switch tracer subset deterministically", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const switch3: IntermediateNode = {
      id: "sw3",
      numericId: 4,
      name: "SW-3",
      type: "switch",
      ports: createPorts(2),
      position: { x: 230, y: 220 },
    };
    const operations: TopologyOperation[] = [
      { op: "link.delete", linkId: "link-2" },
      { op: "node.add", node: switch3 },
      {
        op: "link.add",
        link: {
          id: "link-3",
          numericId: 3,
          source: { nodeId: "sw1", portId: "p2" },
          target: { nodeId: "sw3", portId: "p1" },
          medium: "ethernet",
          dataRateMbps: 1_000,
        },
      },
      {
        op: "link.add",
        link: {
          id: "link-4",
          numericId: 4,
          source: { nodeId: "sw3", portId: "p2" },
          target: { nodeId: "sw2", portId: "p3" },
          medium: "ethernet",
          dataRateMbps: 1_000,
        },
      },
    ];

    const dryRun = applyTopologyOperations({
      topology: initialized.full!.topology,
      operations,
      dryRun: true,
      responseMode: "full",
    });
    const applied = applyTopologyOperations({
      topology: initialized.full!.topology,
      operations,
      responseMode: "full",
    });

    expect(dryRun.ok).toBe(true);
    expect(applied.ok).toBe(true);
    if (dryRun.ok && applied.ok) {
      expect(dryRun.full!.topology).toEqual(applied.full!.topology);
      expect(dryRun.summary.changeSet).toMatchObject({
        dryRun: true,
        addedNodeIds: ["sw3"],
        removedLinkIds: ["link-2"],
        addedLinkIds: ["link-3", "link-4"],
      });
      expect(applied.summary.changeSet.dryRun).toBe(false);
      expect(applied.summary.nodeCount).toBe(5);
      expect(applied.summary.linkCount).toBe(4);
    }
  });

  it("returns structured errors atomically for invalid operations", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const result = applyTopologyOperations({
      topology: initialized.full!.topology,
      operations: [
        {
          op: "link.add",
          link: {
            id: "link-1",
            numericId: 1,
            source: { nodeId: "sw99", portId: "p1" },
            target: { nodeId: "sw1", portId: "p1" },
            medium: "ethernet",
            dataRateMbps: 1_000,
          },
        },
      ],
      responseMode: "full",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "UNKNOWN_ENDPOINT_NODE",
        path: "$.operations[0].link.source.nodeId",
      });
      expect(result).not.toHaveProperty("full.topology");
    }
  });

  it("rejects non-P0 CRUD operations", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const result = applyTopologyOperations({
      topology: initialized.full!.topology,
      operations: [{ op: "node.delete", nodeId: "sw1" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        path: "$.operations[0].op",
      });
    }
  });
});
