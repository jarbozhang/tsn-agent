import type { IntermediateLink, IntermediateNode, IntermediateTopology } from "./intermediate";
import { failResult, okResult, topologyError, type TopologyResponseMode, type TopologyToolResult } from "./tool-result";
import { validateIntermediateTopology } from "./validate";

export interface TopologySelector {
  kind: "node" | "link";
  id?: string;
  name?: string;
  type?: IntermediateNode["type"];
}

export interface TopologyInspectRequest {
  topology: IntermediateTopology;
  selectors?: TopologySelector[];
  includeAdjacency?: boolean;
  responseMode?: TopologyResponseMode;
}

export interface TopologyInspectSummary {
  nodeCount: number;
  linkCount: number;
  selectedNodeIds: string[];
  selectedLinkIds: string[];
  adjacency: Array<{
    nodeId: string;
    usedPorts: string[];
    neighborNodeIds: string[];
  }>;
}

export interface TopologyInspectFull {
  nodes: IntermediateNode[];
  links: IntermediateLink[];
  portUsage: Record<string, Array<{ portId: string; linkId: string; neighborNodeId: string }>>;
}

export function inspectTopology(
  request: TopologyInspectRequest,
): TopologyToolResult<TopologyInspectSummary, TopologyInspectFull> {
  const responseMode = request.responseMode ?? "summary";
  const validation = validateIntermediateTopology(request.topology);

  if (!validation.ok) {
    return failResult({ responseMode, errors: validation.errors, warnings: validation.warnings });
  }

  const selectedNodes = new Map<string, IntermediateNode>();
  const selectedLinks = new Map<string, IntermediateLink>();

  for (const [index, selector] of (request.selectors ?? []).entries()) {
    const result = resolveSelector(request.topology, selector);
    if (!result.ok) {
      return failResult({
        responseMode,
        errors: [
          topologyError({
            code: result.code,
            message: result.message,
            path: `$.selectors[${index}]`,
            details: responseMode === "full" ? { candidates: result.candidates } : { candidateCount: result.candidates.length },
            requiresUserClarification: result.code === "AMBIGUOUS_SELECTOR",
          }),
        ],
      });
    }

    for (const node of result.nodes) {
      selectedNodes.set(node.id, node);
    }

    for (const link of result.links) {
      selectedLinks.set(link.id, link);
    }
  }

  const portUsage = buildPortUsage(request.topology);
  const nodesForAdjacency = selectedNodes.size > 0
    ? [...selectedNodes.values()]
    : request.topology.nodes;

  return okResult({
    responseMode,
    summary: {
      nodeCount: request.topology.nodes.length,
      linkCount: request.topology.links.length,
      selectedNodeIds: [...selectedNodes.keys()].sort(),
      selectedLinkIds: [...selectedLinks.keys()].sort(),
      adjacency: request.includeAdjacency === false
        ? []
        : nodesForAdjacency.map((node) => ({
            nodeId: node.id,
            usedPorts: (portUsage[node.id] ?? []).map((port) => port.portId).sort(),
            neighborNodeIds: [...new Set((portUsage[node.id] ?? []).map((port) => port.neighborNodeId))].sort(),
          })),
    },
    full: {
      nodes: selectedNodes.size > 0 ? [...selectedNodes.values()] : request.topology.nodes,
      links: selectedLinks.size > 0 ? [...selectedLinks.values()] : request.topology.links,
      portUsage,
    },
    warnings: validation.warnings,
  });
}

function resolveSelector(
  topology: IntermediateTopology,
  selector: TopologySelector,
): { ok: true; nodes: IntermediateNode[]; links: IntermediateLink[] } | {
  ok: false;
  code: "AMBIGUOUS_SELECTOR" | "SELECTOR_NOT_FOUND";
  message: string;
  candidates: Array<{ id: string; kind: "node" | "link"; name?: string; type?: string }>;
} {
  if (selector.kind === "node") {
    const matches = topology.nodes.filter((node) =>
      (selector.id === undefined || node.id === selector.id)
        && (selector.name === undefined || node.name === selector.name)
        && (selector.type === undefined || node.type === selector.type)
    );

    if (matches.length === 1) {
      return { ok: true, nodes: matches, links: [] };
    }

    return selectorFailure("node", matches);
  }

  const matches = topology.links.filter((link) =>
    selector.id === undefined || link.id === selector.id
  );

  if (matches.length === 1) {
    return { ok: true, nodes: [], links: matches };
  }

  return selectorFailure("link", matches);
}

function selectorFailure(
  kind: "node" | "link",
  matches: Array<IntermediateNode | IntermediateLink>,
): {
  ok: false;
  code: "AMBIGUOUS_SELECTOR" | "SELECTOR_NOT_FOUND";
  message: string;
  candidates: Array<{ id: string; kind: "node" | "link"; name?: string; type?: string }>;
} {
  if (matches.length === 0) {
    return {
      ok: false,
      code: "SELECTOR_NOT_FOUND",
      message: `No ${kind} matched the selector.`,
      candidates: [],
    };
  }

  return {
    ok: false,
    code: "AMBIGUOUS_SELECTOR",
    message: `${matches.length} ${kind} candidates matched the selector.`,
    candidates: matches.map((candidate) => ({
      id: candidate.id,
      kind,
      name: "name" in candidate ? candidate.name : undefined,
      type: "type" in candidate ? candidate.type : undefined,
    })),
  };
}

function buildPortUsage(topology: IntermediateTopology): Record<string, Array<{ portId: string; linkId: string; neighborNodeId: string }>> {
  const usage: Record<string, Array<{ portId: string; linkId: string; neighborNodeId: string }>> = Object.fromEntries(
    topology.nodes.map((node) => [node.id, []]),
  );

  for (const link of topology.links) {
    usage[link.source.nodeId]?.push({
      portId: link.source.portId,
      linkId: link.id,
      neighborNodeId: link.target.nodeId,
    });
    usage[link.target.nodeId]?.push({
      portId: link.target.portId,
      linkId: link.id,
      neighborNodeId: link.source.nodeId,
    });
  }

  return usage;
}
