import type { CanonicalTsnProjectV0, TsnNode } from "../domain/canonical";
import { NED_CONTRACT } from "./ned-contract";

export function exportNed(project: CanonicalTsnProjectV0): string {
  const imports = NED_CONTRACT.imports.map((item) => `import ${item};`).join("\n");
  const submodules = project.topology.nodes.map(renderSubmodule).join("\n\n");
  const connections = project.topology.links.map(renderConnection).join("\n");

  return [
    `package ${NED_CONTRACT.packageName};`,
    "",
    imports,
    "",
    `network ${NED_CONTRACT.networkName} extends ${NED_CONTRACT.baseNetwork}`,
    "{",
    "    parameters:",
    '        @display("bgb=980,460");',
    `        *.eth[*].bitrate = default(${project.simulationHints.defaultDataRateMbps}Mbps);`,
    "    submodules:",
    submodules,
    "    connections allowunconnected:",
    connections,
    "}",
    "",
  ].join("\n");
}

function renderSubmodule(node: TsnNode): string {
  const moduleType = node.type === "switch" ? NED_CONTRACT.switchModule : NED_CONTRACT.endSystemModule;
  return [
    `        ${safeNedId(node.id)}: ${moduleType} {`,
    `            @display("p=${Math.round(node.position.x)},${Math.round(node.position.y)}");`,
    "        }",
  ].join("\n");
}

function renderConnection(projectLink: CanonicalTsnProjectV0["topology"]["links"][number]): string {
  const dataRate = `${projectLink.dataRateMbps}Mbps`;
  return [
    `        ${safeNedId(projectLink.source.nodeId)}.ethg++ <--> ${NED_CONTRACT.connectionChannel} { datarate = ${dataRate}; } <--> ${safeNedId(projectLink.target.nodeId)}.ethg++;`,
  ].join("");
}

function safeNedId(value: string): string {
  return value.replaceAll("-", "_");
}
