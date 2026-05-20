import type { CanonicalTsnProjectV0 } from "./canonical";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateCanonicalProject(project: CanonicalTsnProjectV0): ValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(project.topology.nodes.map((node) => node.id));
  const linkIds = new Set(project.topology.links.map((link) => link.id));

  if (project.schemaVersion !== "tsn-agent.canonical.v0") {
    errors.push("schemaVersion must be tsn-agent.canonical.v0.");
  }

  if (project.topology.nodes.length === 0) {
    errors.push("topology.nodes must not be empty.");
  }

  for (const node of project.topology.nodes) {
    if (node.ports.length === 0) {
      errors.push(`${node.id} must have at least one port.`);
    }
  }

  for (const link of project.topology.links) {
    if (!nodeIds.has(link.source.nodeId)) {
      errors.push(`${link.id} source node does not exist.`);
    }

    if (!nodeIds.has(link.target.nodeId)) {
      errors.push(`${link.id} target node does not exist.`);
    }
  }

  for (const flow of project.flows) {
    if (!nodeIds.has(flow.source.nodeId)) {
      errors.push(`${flow.id} source node does not exist.`);
    }

    if (!nodeIds.has(flow.destination.nodeId)) {
      errors.push(`${flow.id} destination node does not exist.`);
    }

    for (const linkId of flow.routeLinkIds) {
      if (!linkIds.has(linkId)) {
        errors.push(`${flow.id} route link ${linkId} does not exist.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
