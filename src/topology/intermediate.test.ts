import { describe, expect, it } from "vitest";
import {
  INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
  createPorts,
  summarizeTopology,
  type IntermediateTopology,
} from "./intermediate";
import { validateIntermediateTopology } from "./validate";

function validTopology(): IntermediateTopology {
  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      templateId: "generic-line",
      source: "template",
    },
    nodes: [
      {
        id: "sw1",
        numericId: 0,
        name: "SW-1",
        type: "switch",
        ports: createPorts(2),
        position: { x: 0, y: 0 },
      },
      {
        id: "es1-1",
        numericId: 1,
        name: "ES-1-1",
        type: "endSystem",
        ports: createPorts(1),
        position: { x: 0, y: 100 },
      },
    ],
    links: [
      {
        id: "link-0",
        numericId: 0,
        source: { nodeId: "es1-1", portId: "p1" },
        target: { nodeId: "sw1", portId: "p1" },
        medium: "ethernet",
        dataRateMbps: 1_000,
      },
    ],
    diagnostics: [],
  };
}

describe("IntermediateTopology contract", () => {
  it("accepts a valid P0 intermediate topology", () => {
    const topology = validTopology();

    expect(validateIntermediateTopology(topology)).toMatchObject({
      ok: true,
      summary: {
        nodeCount: 2,
        linkCount: 1,
        switchCount: 1,
        endSystemCount: 1,
      },
    });
    expect(summarizeTopology(topology)).toMatchObject({
      schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
      nodeCount: 2,
      linkCount: 1,
    });
  });

  it("returns stable structured errors for unsupported schema versions", () => {
    const report = validateIntermediateTopology({
      ...validTopology(),
      schemaVersion: "old",
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "$.schemaVersion",
      retryable: false,
      requiresUserClarification: false,
    }));
  });

  it("locates missing node ids, duplicate link ids and invalid ports by path", () => {
    const topology = validTopology();
    const report = validateIntermediateTopology({
      ...topology,
      nodes: [
        topology.nodes[0],
        topology.nodes[1],
        { ...topology.nodes[1], id: "", numericId: 2 },
      ],
      links: [
        topology.links[0],
        {
          ...topology.links[0],
          target: { nodeId: "sw1", portId: "p99" },
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => [error.code, error.path])).toEqual(expect.arrayContaining([
      ["MISSING_NODE_ID", "$.nodes[2].id"],
      ["DUPLICATE_LINK_ID", "$.links[1].id"],
      ["UNKNOWN_ENDPOINT_PORT", "$.links[1].target.portId"],
    ]));
  });

  it("rejects duplicate numeric ids before artifact projection", () => {
    const topology = validTopology();
    const report = validateIntermediateTopology({
      ...topology,
      nodes: [
        topology.nodes[0],
        { ...topology.nodes[1], numericId: topology.nodes[0].numericId },
      ],
      links: [
        topology.links[0],
        {
          ...topology.links[0],
          id: "link-1",
          numericId: topology.links[0].numericId,
          source: { nodeId: "es1-1", portId: "p1" },
          target: { nodeId: "sw1", portId: "p2" },
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => [error.code, error.path])).toEqual(expect.arrayContaining([
      ["DUPLICATE_NODE_NUMERIC_ID", "$.nodes[1].numericId"],
      ["DUPLICATE_LINK_NUMERIC_ID", "$.links[1].numericId"],
    ]));
  });

  it("allows server nodes for compatibility with a warning", () => {
    const topology = validTopology();
    const report = validateIntermediateTopology({
      ...topology,
      nodes: [
        ...topology.nodes,
        {
          id: "server1",
          numericId: 2,
          name: "PC0",
          type: "server",
          ports: createPorts(1),
          position: { x: 100, y: 0 },
        },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "SERVER_NODE_COMPATIBILITY_ONLY",
    }));
  });
});
