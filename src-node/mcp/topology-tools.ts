import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOPOLOGY_TOOL_NAMES,
  type TopologyToolName,
} from "../../src/topology/topology-service";
import { buildTopologyArtifacts, describeTopologyArtifacts, validateTopologyArtifacts, type TopologyArtifacts } from "../../src/topology/artifacts";
import { initializeTopology, type TopologyInitIntent } from "../../src/topology/initialize";
import { inspectTopology, type TopologyInspectRequest } from "../../src/topology/inspect";
import { applyTopologyOperations, type TopologyApplyOperationsRequest } from "../../src/topology/operations";
import { describeTemplates } from "../../src/topology/templates";
import { forbiddenFullResponseError, failResult, type TopologyResponseMode, type TopologyToolResult } from "../../src/topology/tool-result";
import { validateIntermediateTopology } from "../../src/topology/validate";
import { TOPOLOGY_LIMITS, measureJsonBytes, measureJsonDepth } from "../../src/topology/limits";

export const TOPOLOGY_MCP_ALLOWED_TOOLS = [
  "mcp__tsn_topology__topology_describe_templates",
  "mcp__tsn_topology__topology_initialize",
  "mcp__tsn_topology__topology_inspect",
  "mcp__tsn_topology__topology_describe_artifacts",
  "mcp__tsn_topology__topology_validate_intermediate",
  "mcp__tsn_topology__topology_build_artifacts",
  "mcp__tsn_topology__topology_validate_artifacts",
  "mcp__tsn_topology__topology_apply_operations",
] as const;

export interface TopologyMcpToolDefinition {
  name: TopologyToolName;
  allowedToolName: (typeof TOPOLOGY_MCP_ALLOWED_TOOLS)[number];
  title: string;
  description: string;
  handler: (args: unknown) => Promise<CallToolResult> | CallToolResult;
}

export function createTopologyToolRegistry(): TopologyMcpToolDefinition[] {
  return [
    {
      name: "topology.describe_templates",
      allowedToolName: "mcp__tsn_topology__topology_describe_templates",
      title: "Describe topology templates",
      description: "Return the deterministic P0 topology template catalog.",
      handler: () => toCallToolResult({ ok: true, summary: describeTemplates().summary, full: undefined, warnings: [], metadata: { responseMode: "summary", summaryOnly: true } }),
    },
    {
      name: "topology.initialize",
      allowedToolName: "mcp__tsn_topology__topology_initialize",
      title: "Initialize topology",
      description: "Create an IntermediateTopology from a structured template id and params.",
      handler: (args) => toCallToolResult(runAgentFacing(() => initializeTopology(args as TopologyInitIntent), args)),
    },
    {
      name: "topology.inspect",
      allowedToolName: "mcp__tsn_topology__topology_inspect",
      title: "Inspect topology",
      description: "Inspect nodes, links and adjacency summaries by structured selectors.",
      handler: (args) => toCallToolResult(runAgentFacing(() => inspectTopology(args as TopologyInspectRequest), args)),
    },
    {
      name: "topology.describe_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_describe_artifacts",
      title: "Describe topology artifacts",
      description: "Return deterministic artifact count and size summaries.",
      handler: (args) => toCallToolResult(runAgentFacing(
        () => describeTopologyArtifacts((args ?? {}) as { artifacts: TopologyArtifacts; responseMode?: TopologyResponseMode }),
        args,
      )),
    },
    {
      name: "topology.validate_intermediate",
      allowedToolName: "mcp__tsn_topology__topology_validate_intermediate",
      title: "Validate intermediate topology",
      description: "Validate an IntermediateTopology and return structured errors.",
      handler: (args) => toCallToolResult(runAgentFacing(() => {
        const report = validateIntermediateTopology((args as { topology?: unknown })?.topology ?? args);
        return report.ok
          ? {
              ok: true,
              summary: report.summary,
              warnings: report.warnings,
              metadata: { responseMode: "summary", summaryOnly: true },
            }
          : failResult({ errors: report.errors, warnings: report.warnings });
      }, args)),
    },
    {
      name: "topology.build_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_build_artifacts",
      title: "Build topology artifacts",
      description: "Build four legacy JSON topology artifacts from an IntermediateTopology.",
      handler: (args) => toCallToolResult(runAgentFacing(
        () => buildTopologyArtifacts((args ?? {}) as Parameters<typeof buildTopologyArtifacts>[0]),
        args,
      )),
    },
    {
      name: "topology.validate_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_validate_artifacts",
      title: "Validate topology artifacts",
      description: "Validate legacy JSON artifact references.",
      handler: (args) => toCallToolResult(runAgentFacing(
        () => validateTopologyArtifacts((args ?? {}) as Parameters<typeof validateTopologyArtifacts>[0]),
        args,
      )),
    },
    {
      name: "topology.apply_operations",
      allowedToolName: "mcp__tsn_topology__topology_apply_operations",
      title: "Apply topology operations",
      description: "Apply the P0 insert-switch operation subset to an IntermediateTopology.",
      handler: (args) => toCallToolResult(runAgentFacing(
        () => applyTopologyOperations((args ?? {}) as TopologyApplyOperationsRequest),
        args,
      )),
    },
  ];
}

export function runTopologyTool(name: TopologyToolName, args: unknown): CallToolResult {
  const tool = createTopologyToolRegistry().find((candidate) => candidate.name === name);

  if (!tool) {
    return toCallToolResult(failResult({
      errors: [
        {
          code: "UNKNOWN_TOOL",
          message: `Unknown topology tool: ${name}`,
          path: "$.name",
          severity: "error",
          retryable: false,
          requiresUserClarification: false,
        },
      ],
    }));
  }

  return tool.handler(args) as CallToolResult;
}

function runAgentFacing<TSummary, TFull>(
  callback: () => TopologyToolResult<TSummary, TFull>,
  args: unknown,
): TopologyToolResult<TSummary, TFull> {
  const ingressError = validateIngress(args);
  if (ingressError) {
    return failResult({ errors: [ingressError] });
  }

  if (isFullResponseMode(args)) {
    return failResult({ errors: [forbiddenFullResponseError()] });
  }

  try {
    return callback();
  } catch (error) {
    return failResult({
      errors: [
        {
          code: "CALL_FAILED",
          message: error instanceof Error ? error.message : String(error),
          path: "$",
          severity: "error",
          retryable: true,
          requiresUserClarification: false,
        },
      ],
    });
  }
}

function validateIngress(args: unknown) {
  const bytes = measureJsonBytes(args ?? {});
  if (bytes > TOPOLOGY_LIMITS.maxIngressPayloadBytes) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `ingress payload bytes exceeded: ${bytes} > ${TOPOLOGY_LIMITS.maxIngressPayloadBytes}`,
      path: "$",
      severity: "error" as const,
      details: {
        limit: "maxIngressPayloadBytes",
        actual: bytes,
        maximum: TOPOLOGY_LIMITS.maxIngressPayloadBytes,
      },
      retryable: false,
      requiresUserClarification: false,
    };
  }

  const depth = measureJsonDepth(args ?? {});
  if (depth > TOPOLOGY_LIMITS.maxJsonDepth) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `JSON depth exceeded: ${depth} > ${TOPOLOGY_LIMITS.maxJsonDepth}`,
      path: "$",
      severity: "error" as const,
      details: {
        limit: "maxJsonDepth",
        actual: depth,
        maximum: TOPOLOGY_LIMITS.maxJsonDepth,
      },
      retryable: false,
      requiresUserClarification: false,
    };
  }

  return undefined;
}

function isFullResponseMode(args: unknown): boolean {
  return Boolean(args && typeof args === "object" && "responseMode" in args && (args as { responseMode?: unknown }).responseMode === "full");
}

function toCallToolResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

export function expectedAllowedToolName(name: TopologyToolName): string {
  return `mcp__tsn_topology__${name.replaceAll(".", "_")}`;
}

export function assertTopologyToolMapping(): void {
  const registry = createTopologyToolRegistry();
  const names = registry.map((tool) => tool.name);

  if (JSON.stringify(names) !== JSON.stringify(TOPOLOGY_TOOL_NAMES)) {
    throw new Error(`Topology MCP tool registry drifted: ${names.join(", ")}`);
  }

  for (const tool of registry) {
    if (tool.allowedToolName !== expectedAllowedToolName(tool.name)) {
      throw new Error(`Topology MCP allowed tool mapping drifted for ${tool.name}.`);
    }
  }
}
