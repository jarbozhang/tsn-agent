import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOPOLOGY_TOOL_NAMES } from "../../src/topology/topology-service";
import { initializeTopology } from "../../src/topology/initialize";
import {
  TOPOLOGY_MCP_ALLOWED_TOOLS,
  assertTopologyToolMapping,
  createTopologyToolRegistry,
  runTopologyTool,
} from "./topology-tools";
import { createTsnTopologyMcpServer } from "./tsn-topology-server";

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("topology MCP tool registry", () => {
  it("registers only the P0 topology tools and allowedTool mappings", () => {
    const registry = createTopologyToolRegistry();

    expect(registry.map((tool) => tool.name)).toEqual(TOPOLOGY_TOOL_NAMES);
    expect(registry.map((tool) => tool.allowedToolName)).toEqual(TOPOLOGY_MCP_ALLOWED_TOOLS);
    expect(registry.map((tool) => tool.name)).not.toContain("topology.render_mac_table_html");
    expect(() => assertTopologyToolMapping()).not.toThrow();
  });

  it("returns structured template summaries", () => {
    const payload = parseToolText(runTopologyTool("topology.describe_templates", {}));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        templateCount: 3,
        templateIds: ["generic-line", "generic-ring", "aerospace-redundant"],
      },
      metadata: {
        responseMode: "summary",
        summaryOnly: true,
      },
    });
  });

  it("rejects Agent-facing full response mode", () => {
    const payload = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      responseMode: "full",
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [
        {
          code: "FORBIDDEN_RESPONSE_MODE",
          path: "$.responseMode",
        },
      ],
    });
  });

  it("summarizes initialize results without full topology data", () => {
    const payload = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
    }));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        templateId: "generic-line",
        nodeCount: 4,
        linkCount: 3,
      },
    });
    expect(payload).not.toHaveProperty("full.topology");
  });

  it("maps invalid inputs to structured errors", () => {
    const payload = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      params: { switchCount: 200 },
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [
        {
          code: "INVALID_TEMPLATE_PARAM",
          path: "$.params.switchCount",
        },
      ],
    });
  });

  it("handles build_artifacts through the same summary boundary", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const payload = parseToolText(runTopologyTool("topology.build_artifacts", {
      topology: initialized.full!.topology,
    }));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        artifactCount: 4,
        containsHtml: false,
      },
    });
    expect(payload).not.toHaveProperty("full.artifacts");
  });

  it("passes real MCP tool arguments through without a payload wrapper", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTsnTopologyMcpServer();
    const client = new Client({ name: "topology-tools-test", version: "0.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const result = await client.callTool({
        name: "topology.initialize",
        arguments: {
          templateId: "generic-line",
          params: { switchCount: 2, endSystemsPerSwitch: 1 },
        },
      });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
      const payload = JSON.parse(text);

      expect(payload).toMatchObject({
        ok: true,
        summary: {
          templateId: "generic-line",
          nodeCount: 4,
          linkCount: 3,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
