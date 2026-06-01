import {
  INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
  createPorts,
  deriveMacAddress,
  type IntermediateLink,
  type IntermediateNode,
  type IntermediateTopology,
  type TopologyTemplateId,
} from "./intermediate";
import { SUPPORTED_DATA_RATES_MBPS, findTemplate } from "./templates";
import { failResult, okResult, topologyError, type TopologyResponseMode, type TopologyToolResult } from "./tool-result";
import { validateIntermediateTopology } from "./validate";

export interface TopologyInitIntent {
  templateId: TopologyTemplateId;
  params?: {
    switchCount?: number;
    endSystemsPerSwitch?: number;
    endSystemCount?: number;
    dataRateMbps?: number;
  };
  responseMode?: TopologyResponseMode;
}

export interface TopologyInitializeSummary {
  templateId: TopologyTemplateId;
  nodeCount: number;
  linkCount: number;
  switchCount: number;
  endSystemCount: number;
  serverCount: number;
}

export interface TopologyInitializeFull {
  topology: IntermediateTopology;
}

export function initializeTopology(
  intent: TopologyInitIntent,
): TopologyToolResult<TopologyInitializeSummary, TopologyInitializeFull> {
  const responseMode = intent.responseMode ?? "summary";
  const template = findTemplate(intent.templateId);

  if (!template) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "UNKNOWN_TEMPLATE_ID",
          message: `Unknown topology templateId: ${String(intent.templateId)}`,
          path: "$.templateId",
          requiresUserClarification: true,
        }),
      ],
    });
  }

  const dataRateResult = normalizeDataRate(intent.params?.dataRateMbps);
  if (!dataRateResult.ok) {
    return failResult({ responseMode, errors: [dataRateResult.error] });
  }

  let topology: IntermediateTopology;
  if (intent.templateId === "aerospace-redundant") {
    const endSystemCount = normalizeIntegerParam(intent.params?.endSystemCount, 7, 1, 24, "$.params.endSystemCount");
    if (!endSystemCount.ok) {
      return failResult({ responseMode, errors: [endSystemCount.error] });
    }
    topology = createAerospaceRedundantTopology(endSystemCount.value, dataRateResult.value);
  } else {
    const switchCount = normalizeIntegerParam(intent.params?.switchCount, 4, 1, 12, "$.params.switchCount");
    if (!switchCount.ok) {
      return failResult({ responseMode, errors: [switchCount.error] });
    }

    const endSystemsPerSwitch = normalizeIntegerParam(
      intent.params?.endSystemsPerSwitch,
      2,
      1,
      24,
      "$.params.endSystemsPerSwitch",
    );
    if (!endSystemsPerSwitch.ok) {
      return failResult({ responseMode, errors: [endSystemsPerSwitch.error] });
    }

    topology = createGenericDistributedTopology({
      templateId: intent.templateId,
      switchCount: switchCount.value,
      endSystemsPerSwitch: endSystemsPerSwitch.value,
      dataRateMbps: dataRateResult.value,
    });
  }

  const validation = validateIntermediateTopology(topology);
  if (!validation.ok) {
    return failResult({ responseMode, errors: validation.errors, warnings: validation.warnings });
  }

  return okResult({
    responseMode,
    summary: {
      templateId: intent.templateId,
      nodeCount: topology.nodes.length,
      linkCount: topology.links.length,
      switchCount: topology.nodes.filter((node) => node.type === "switch").length,
      endSystemCount: topology.nodes.filter((node) => node.type === "endSystem").length,
      serverCount: topology.nodes.filter((node) => node.type === "server").length,
    },
    full: { topology },
    warnings: validation.warnings,
  });
}

function createGenericDistributedTopology(input: {
  templateId: "generic-line" | "generic-ring";
  switchCount: number;
  endSystemsPerSwitch: number;
  dataRateMbps: number;
}): IntermediateTopology {
  const nodes: IntermediateNode[] = [];
  const links: IntermediateLink[] = [];
  const switchIds: string[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;

  for (let switchIndex = 1; switchIndex <= input.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;
    const switchX = 80 + 300 * (switchIndex - 1);
    switchIds.push(switchId);
    nodes.push({
      id: switchId,
      numericId: numericNodeId,
      name: `SW-${switchIndex}`,
      type: "switch",
      ports: createPorts(input.endSystemsPerSwitch + 2),
      position: { x: switchX, y: 220 },
    });
    numericNodeId += 1;
  }

  for (let switchIndex = 1; switchIndex <= input.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;

    for (let hostIndex = 1; hostIndex <= input.endSystemsPerSwitch; hostIndex += 1) {
      const hostId = `es${switchIndex}-${hostIndex}`;
      const hostOrdinal = (switchIndex - 1) * input.endSystemsPerSwitch + hostIndex;
      const switchX = 80 + 300 * (switchIndex - 1);
      const yOffset = hostIndex % 2 === 0 ? 390 : 70;
      const xJitter = (hostIndex - Math.ceil(input.endSystemsPerSwitch / 2)) * 62;

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
        macAddress: deriveMacAddress(hostOrdinal),
        ipAddress: `10.0.${switchIndex}.${hostIndex}`,
      });
      numericNodeId += 1;

      links.push(createLink({
        numericId: numericLinkId,
        sourceNodeId: hostId,
        sourcePortId: "p1",
        targetNodeId: switchId,
        targetPortId: `p${hostIndex}`,
        dataRateMbps: input.dataRateMbps,
      }));
      numericLinkId += 1;
    }
  }

  const switchInterconnectPortOffset = input.endSystemsPerSwitch;
  for (let index = 0; index < switchIds.length - 1; index += 1) {
    links.push(createLink({
      numericId: numericLinkId,
      sourceNodeId: switchIds[index],
      sourcePortId: `p${switchInterconnectPortOffset + 1}`,
      targetNodeId: switchIds[index + 1],
      targetPortId: `p${switchInterconnectPortOffset + 2}`,
      dataRateMbps: input.dataRateMbps,
    }));
    numericLinkId += 1;
  }

  if (input.templateId === "generic-ring" && switchIds.length > 2) {
    links.push(createLink({
      numericId: numericLinkId,
      sourceNodeId: switchIds[switchIds.length - 1],
      sourcePortId: `p${switchInterconnectPortOffset + 1}`,
      targetNodeId: switchIds[0],
      targetPortId: `p${switchInterconnectPortOffset + 2}`,
      dataRateMbps: input.dataRateMbps,
    }));
  }

  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      templateId: input.templateId,
      templateParams: {
        switchCount: input.switchCount,
        endSystemsPerSwitch: input.endSystemsPerSwitch,
        dataRateMbps: input.dataRateMbps,
      },
      layout: input.templateId === "generic-ring" ? "ring" : "line",
      source: "template",
    },
    nodes,
    links,
    diagnostics: [],
  };
}

function createAerospaceRedundantTopology(endSystemCount: number, dataRateMbps: number): IntermediateTopology {
  const leftEndSystemCount = Math.min(3, endSystemCount);
  const middleEndSystemCount = Math.max(0, Math.min(2, endSystemCount - leftEndSystemCount));
  const rightEndSystemCount = Math.max(0, endSystemCount - leftEndSystemCount - middleEndSystemCount);
  const sw3PortCount = Math.max(6, rightEndSystemCount + 2);
  const nodes: IntermediateNode[] = [];
  const links: IntermediateLink[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;

  const addNode = (input: {
    id: string;
    name: string;
    type: IntermediateNode["type"];
    portCount: number;
    position: IntermediateNode["position"];
    hostOrdinal?: number;
  }) => {
    nodes.push({
      id: input.id,
      numericId: numericNodeId,
      name: input.name,
      type: input.type,
      ports: createPorts(input.portCount),
      position: input.position,
      macAddress: input.hostOrdinal === undefined ? undefined : deriveMacAddress(input.hostOrdinal),
      ipAddress: input.hostOrdinal === undefined ? undefined : `10.10.0.${input.hostOrdinal}`,
    });
    numericNodeId += 1;
  };

  const addLink = (sourceNodeId: string, sourcePortId: string, targetNodeId: string, targetPortId: string) => {
    links.push(createLink({
      numericId: numericLinkId,
      sourceNodeId,
      sourcePortId,
      targetNodeId,
      targetPortId,
      dataRateMbps,
    }));
    numericLinkId += 1;
  };

  for (let index = 1; index <= leftEndSystemCount; index += 1) {
    addNode({
      id: `nic${index}`,
      name: `网卡${index}`,
      type: "endSystem",
      portCount: 2,
      position: { x: 30, y: leftAerospaceY(index) },
      hostOrdinal: index,
    });
  }

  addNode({ id: "sw1", name: "交换机1", type: "switch", portCount: 8, position: { x: 210, y: 55 } });
  addNode({ id: "sw2", name: "交换机2", type: "switch", portCount: 8, position: { x: 210, y: 195 } });

  for (let offset = 0; offset < middleEndSystemCount; offset += 1) {
    const ordinal = leftEndSystemCount + offset + 1;
    addNode({
      id: `nic${ordinal}`,
      name: `网卡${ordinal}`,
      type: "endSystem",
      portCount: 2,
      position: { x: 380, y: middleAerospaceY(offset) },
      hostOrdinal: ordinal,
    });
  }

  addNode({ id: "sw3", name: "交换机3", type: "switch", portCount: sw3PortCount, position: { x: 590, y: 55 } });
  addNode({ id: "sw4", name: "交换机4", type: "switch", portCount: sw3PortCount, position: { x: 590, y: 195 } });

  for (let offset = 0; offset < rightEndSystemCount; offset += 1) {
    const ordinal = leftEndSystemCount + middleEndSystemCount + offset + 1;
    addNode({
      id: `nic${ordinal}`,
      name: `网卡${ordinal}`,
      type: "endSystem",
      portCount: 2,
      position: { x: 760, y: rightAerospaceY(offset) },
      hostOrdinal: ordinal,
    });
  }

  for (let ordinal = 1; ordinal <= leftEndSystemCount; ordinal += 1) {
    addLink(`nic${ordinal}`, "p1", "sw1", `p${ordinal}`);
    addLink(`nic${ordinal}`, "p2", "sw2", `p${ordinal}`);
  }

  for (let offset = 0; offset < middleEndSystemCount; offset += 1) {
    const ordinal = leftEndSystemCount + offset + 1;
    addLink("sw1", `p${ordinal}`, `nic${ordinal}`, "p1");
    addLink("sw2", `p${ordinal}`, `nic${ordinal}`, "p2");
  }

  addLink("sw1", "p6", "sw3", "p1");
  addLink("sw2", "p6", "sw4", "p1");

  for (let offset = 0; offset < rightEndSystemCount; offset += 1) {
    const ordinal = leftEndSystemCount + middleEndSystemCount + offset + 1;
    const switchPort = offset + 3;
    addLink("sw3", `p${switchPort}`, `nic${ordinal}`, "p1");
    addLink("sw4", `p${switchPort}`, `nic${ordinal}`, "p2");
  }

  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      templateId: "aerospace-redundant",
      templateParams: {
        endSystemCount,
        dataRateMbps,
      },
      layout: "aerospace-redundant",
      source: "template",
    },
    nodes,
    links,
    diagnostics: [],
  };
}

function createLink(input: {
  numericId: number;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  dataRateMbps: number;
}): IntermediateLink {
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

function leftAerospaceY(ordinal: number): number {
  return [40, 160, 300][ordinal - 1] ?? 40 + (ordinal - 1) * 120;
}

function middleAerospaceY(offset: number): number {
  return [80, 210][offset] ?? 80 + offset * 130;
}

function rightAerospaceY(offset: number): number {
  return [40, 195][offset] ?? 40 + offset * 95;
}

function normalizeIntegerParam(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
  path: string,
): { ok: true; value: number } | { ok: false; error: ReturnType<typeof topologyError> } {
  const normalized = value === undefined ? defaultValue : Number(value);

  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    return {
      ok: false,
      error: topologyError({
        code: "INVALID_TEMPLATE_PARAM",
        message: `${path} must be an integer in [${minimum}, ${maximum}].`,
        path,
        details: {
          minimum,
          maximum,
          actual: String(value),
        },
        requiresUserClarification: true,
      }),
    };
  }

  return { ok: true, value: normalized };
}

function normalizeDataRate(value: unknown): { ok: true; value: number } | { ok: false; error: ReturnType<typeof topologyError> } {
  const normalized = value === undefined ? 1_000 : Number(value);

  if (!SUPPORTED_DATA_RATES_MBPS.some((candidate) => candidate === normalized)) {
    return {
      ok: false,
      error: topologyError({
        code: "INVALID_TEMPLATE_PARAM",
        message: `$.params.dataRateMbps must be one of ${SUPPORTED_DATA_RATES_MBPS.join(", ")}.`,
        path: "$.params.dataRateMbps",
        details: {
          allowed: [...SUPPORTED_DATA_RATES_MBPS],
          actual: String(value),
        },
        requiresUserClarification: true,
      }),
    };
  }

  return { ok: true, value: normalized };
}
