import { describe, expect, it } from "vitest";
import { createPorts, INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION, type IntermediateTopology } from "./intermediate";
import { initializeTopology } from "./initialize";
import { canonicalTopologyToIntermediate, intermediateToCanonicalProject } from "./project-bridge";
import { validateCanonicalProject } from "../domain/validation";

describe("topology project bridge", () => {
  it("converts initialized topology into a valid canonical project", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const result = intermediateToCanonicalProject({
      topology: initialized.full!.topology,
      options: {
        timestamp: "2026-05-28T00:00:00.000Z",
        responseMode: "full",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateCanonicalProject(result.full!.project)).toEqual({ ok: true, errors: [] });
      expect(result.full!.project.flows).toEqual([]);
      expect(result.full!.project.createdAt).toBe("2026-05-28T00:00:00.000Z");
    }
  });

  it("round-trips canonical topology fields through intermediate", () => {
    const initialized = initializeTopology({
      templateId: "generic-ring",
      params: { switchCount: 3, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }
    const projectResult = intermediateToCanonicalProject({
      topology: initialized.full!.topology,
      options: { responseMode: "full" },
    });
    expect(projectResult.ok).toBe(true);
    if (!projectResult.ok) {
      return;
    }

    const intermediate = canonicalTopologyToIntermediate(projectResult.full!.project);

    expect(intermediate.nodes.map((node) => node.id)).toEqual(initialized.full!.topology.nodes.map((node) => node.id));
    expect(intermediate.links.map((link) => link.id)).toEqual(initialized.full!.topology.links.map((link) => link.id));
  });

  it("returns a structured error for server nodes", () => {
    const topology: IntermediateTopology = {
      schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
      metadata: { source: "legacy-artifacts" },
      nodes: [
        {
          id: "server1",
          numericId: 0,
          name: "PC0",
          type: "server",
          ports: createPorts(1),
          position: { x: 0, y: 0 },
        },
      ],
      links: [],
      diagnostics: [],
    };

    const result = intermediateToCanonicalProject({ topology });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "UNSUPPORTED_CANONICAL_NODE_TYPE",
        path: "$.nodes[0].type",
      });
    }
  });
});
