import type {
  CanonicalTsnProjectV0,
  TopologyIntent,
  TsnFlow,
  TsnLink,
  TsnNode,
  TsnPort,
} from "./canonical";
import { getScenarioConfig, resolveScenarioConfig, type ScenarioFlowTemplate } from "./scenario-config";

export interface TopologyFactoryOptions {
  scenarioConfigId?: string;
}

export function parseTopologyIntent(
  text: string,
  fallback?: Partial<TopologyIntent>,
  options: TopologyFactoryOptions = {},
): TopologyIntent {
  const switchMatch = text.match(/(\d+)\s*(?:个|台)?\s*(?:交换机|switch)/i);
  const endSystemMatch = text.match(/(?:每个|each).*?(\d+)\s*(?:个|台)?\s*(?:端系统|终端|端|host|end)/i);
  const defaults = getScenarioConfig(options.scenarioConfigId).defaults.topology;

  return {
    switchCount: clampNumber(Number(switchMatch?.[1] ?? fallback?.switchCount ?? defaults.switchCount), 1, 12),
    endSystemsPerSwitch: clampNumber(
      Number(endSystemMatch?.[1] ?? fallback?.endSystemsPerSwitch ?? defaults.endSystemsPerSwitch),
      1,
      24,
    ),
  };
}

export function createProjectFromIntent(
  text: string,
  fallback?: Partial<TopologyIntent>,
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const intent = parseTopologyIntent(text, fallback, options);
  return createLineTopologyProject(intent, "当前规划", options);
}

export function createLineTopologyProject(
  intent: TopologyIntent,
  projectName = "TSN Agent Project",
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId).config;
  const dataRateMbps = scenarioConfig.defaults.topology.dataRateMbps;
  const now = new Date().toISOString();
  const nodes: TsnNode[] = [];
  const links: TsnLink[] = [];
  const switchIds: string[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;

  for (let switchIndex = 1; switchIndex <= intent.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;
    const switchX = 80 + 300 * (switchIndex - 1);
    switchIds.push(switchId);
    nodes.push({
      id: switchId,
      numericId: numericNodeId,
      name: `SW-${switchIndex}`,
      type: "switch",
      ports: createPorts(intent.endSystemsPerSwitch + 2),
      position: { x: switchX, y: 220 },
    });
    numericNodeId += 1;
  }

  for (let switchIndex = 1; switchIndex <= intent.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;

    for (let hostIndex = 1; hostIndex <= intent.endSystemsPerSwitch; hostIndex += 1) {
      const hostId = `es${switchIndex}-${hostIndex}`;
      const hostOrdinal = (switchIndex - 1) * intent.endSystemsPerSwitch + hostIndex;
      const switchX = 80 + 300 * (switchIndex - 1);
      const yOffset = hostIndex % 2 === 0 ? 390 : 70;
      const xJitter = (hostIndex - Math.ceil(intent.endSystemsPerSwitch / 2)) * 62;

      nodes.push({
        id: hostId,
        numericId: numericNodeId,
        name: `ES-${switchIndex}-${hostIndex}`,
        type: "endSystem",
        ports: createPorts(1),
        position: {
          x: switchX + xJitter,
          y: yOffset,
        },
        macAddress: createMacAddress(hostOrdinal),
        ipAddress: `10.0.${switchIndex}.${hostIndex}`,
      });
      numericNodeId += 1;

      links.push(
        createLink({
          numericId: numericLinkId,
          sourceNodeId: hostId,
          sourcePortId: "p1",
          targetNodeId: switchId,
          targetPortId: `p${hostIndex}`,
          dataRateMbps,
        }),
      );
      numericLinkId += 1;
    }
  }

  for (let index = 0; index < switchIds.length - 1; index += 1) {
    links.push(
      createLink({
        numericId: numericLinkId,
        sourceNodeId: switchIds[index],
        sourcePortId: `p${intent.endSystemsPerSwitch + 1}`,
        targetNodeId: switchIds[index + 1],
        targetPortId: `p${intent.endSystemsPerSwitch + 2}`,
        dataRateMbps,
      }),
    );
    numericLinkId += 1;
  }

  const flows = [createControlFlow(nodes, links, intent, scenarioConfig.flowTemplates[0])];

  return {
    schemaVersion: "tsn-agent.canonical.v0",
    id: "project-default",
    name: projectName,
    createdAt: now,
    updatedAt: now,
    topology: { nodes, links },
    flows,
    simulationHints: {
      inetVersion: "INET 4.x",
      nedPackage: "tsnagent.generated",
      defaultDataRateMbps: dataRateMbps,
      timeSynchronization: "assumed-synchronized",
    },
  };
}

function createPorts(count: number): TsnPort[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `eth${index}`,
    index,
  }));
}

function createLink(input: {
  numericId: number;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  dataRateMbps: number;
}): TsnLink {
  return {
    id: `link-${input.numericId}`,
    numericId: input.numericId,
    source: {
      nodeId: input.sourceNodeId,
      portId: input.sourcePortId,
    },
    target: {
      nodeId: input.targetNodeId,
      portId: input.targetPortId,
    },
    medium: "ethernet",
    dataRateMbps: input.dataRateMbps,
  };
}

function createControlFlow(
  nodes: TsnNode[],
  links: TsnLink[],
  intent: TopologyIntent,
  template: ScenarioFlowTemplate,
): TsnFlow {
  const sourceNode = findNode(nodes, "es1-1");
  const destinationNode = findNode(nodes, `es${intent.switchCount}-1`);
  const routeNodeIds = [
    sourceNode.id,
    ...Array.from({ length: intent.switchCount }, (_, index) => `sw${index + 1}`),
    destinationNode.id,
  ];
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: "flow-control-1",
    numericId: 1,
    name: template.name,
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(1),
      ipAddress: sourceNode.ipAddress ?? "10.0.1.1",
      udpPort: 25563,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(intent.switchCount),
      ipAddress: destinationNode.ipAddress ?? `10.0.${intent.switchCount}.1`,
      udpPort: 26028,
    },
    periodUs: template.periodUs,
    frameSizeBytes: template.frameSizeBytes,
    pcp: template.pcp,
    maxFramesPerInterval: 1,
    earliestTransmitOffsetUs: 0,
    latestTransmitOffsetUs: 50,
    jitterRequirementUs: template.jitterRequirementUs,
    latencyRequirementUs: template.latencyRequirementUs,
    routeLinkIds,
    routeNodeIds,
    flowType: template.flowType,
  };
}

function createRouteLinkIds(routeNodeIds: string[], links: TsnLink[]): string[] {
  const routeLinkIds: string[] = [];

  for (let index = 0; index < routeNodeIds.length - 1; index += 1) {
    const fromNodeId = routeNodeIds[index];
    const toNodeId = routeNodeIds[index + 1];
    const link = links.find((candidate) => {
      const forward = candidate.source.nodeId === fromNodeId && candidate.target.nodeId === toNodeId;
      const backward = candidate.source.nodeId === toNodeId && candidate.target.nodeId === fromNodeId;
      return forward || backward;
    });

    if (!link) {
      throw new Error(`No link exists between ${fromNodeId} and ${toNodeId}.`);
    }

    routeLinkIds.push(link.id);
  }

  return routeLinkIds;
}

function findNode(nodes: TsnNode[], nodeId: string): TsnNode {
  const node = nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw new Error(`Node ${nodeId} does not exist.`);
  }

  return node;
}

function createMacAddress(ordinal: number): string {
  const hex = ordinal.toString(16).padStart(2, "0").toUpperCase();
  return `00:1B:44:11:3A:${hex}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}
