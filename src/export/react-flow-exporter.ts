import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";

export interface ReactFlowTopologyJson {
  schemaVersion: "tsn-agent.react-flow-topology.v0";
  nodes: Node[];
  edges: Edge[];
}

export function exportReactFlowTopology(project: CanonicalTsnProjectV0): ReactFlowTopologyJson {
  return {
    schemaVersion: "tsn-agent.react-flow-topology.v0",
    nodes: project.topology.nodes.map((node) => ({
      id: node.id,
      type: "tsnNode",
      position: node.position,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: node.name,
        nodeType: node.type,
        portCount: node.ports.length,
        ipAddress: node.ipAddress,
      },
    })),
    edges: project.topology.links.map((link) => ({
      id: link.id,
      source: link.source.nodeId,
      target: link.target.nodeId,
      markerEnd: {
        type: MarkerType.ArrowClosed,
      },
      data: {
        numericId: link.numericId,
        sourcePortId: link.source.portId,
        targetPortId: link.target.portId,
      },
    })),
  };
}
