import type { TopologyTemplateId } from "./intermediate";

export interface TopologyTemplateParam {
  name: string;
  type: "integer" | "enum";
  default: number | string;
  minimum?: number;
  maximum?: number;
  values?: Array<number | string>;
  description: string;
}

export interface TopologyTemplateDescription {
  id: TopologyTemplateId;
  name: string;
  description: string;
  tags: string[];
  params: TopologyTemplateParam[];
  example: Record<string, number | string>;
}

export interface TopologyTemplateCatalogSummary {
  templateCount: number;
  templateIds: TopologyTemplateId[];
}

export const SUPPORTED_DATA_RATES_MBPS = [10, 100, 1_000, 10_000] as const;

export function describeTemplates(): {
  summary: TopologyTemplateCatalogSummary;
  templates: TopologyTemplateDescription[];
} {
  const templates: TopologyTemplateDescription[] = [
    {
      id: "generic-line",
      name: "通用线型拓扑",
      description: "多台交换机线型互联，每台交换机接入固定数量端系统。",
      tags: ["generic", "line", "beginner"],
      params: genericDistributedParams(),
      example: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
    },
    {
      id: "generic-ring",
      name: "通用环形拓扑",
      description: "多台交换机环形互联，每台交换机接入固定数量端系统。",
      tags: ["generic", "ring", "redundant"],
      params: genericDistributedParams(),
      example: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
    },
    {
      id: "aerospace-redundant",
      name: "箭载双冗余拓扑",
      description: "四台系统交换机组成左右双平面，网卡双归属接入，左右通过主干链路互联。",
      tags: ["aerospace", "dual-plane", "redundant"],
      params: [
        {
          name: "endSystemCount",
          type: "integer",
          default: 7,
          minimum: 1,
          maximum: 24,
          description: "网卡/端系统总数。",
        },
        dataRateParam(),
      ],
      example: {
        endSystemCount: 7,
        dataRateMbps: 1_000,
      },
    },
  ];

  return {
    summary: {
      templateCount: templates.length,
      templateIds: templates.map((template) => template.id),
    },
    templates,
  };
}

export function findTemplate(templateId: string): TopologyTemplateDescription | undefined {
  return describeTemplates().templates.find((template) => template.id === templateId);
}

function genericDistributedParams(): TopologyTemplateParam[] {
  return [
    {
      name: "switchCount",
      type: "integer",
      default: 4,
      minimum: 1,
      maximum: 12,
      description: "交换机数量。",
    },
    {
      name: "endSystemsPerSwitch",
      type: "integer",
      default: 2,
      minimum: 1,
      maximum: 24,
      description: "每台交换机接入的端系统数量。",
    },
    dataRateParam(),
  ];
}

function dataRateParam(): TopologyTemplateParam {
  return {
    name: "dataRateMbps",
    type: "enum",
    default: 1_000,
    values: [...SUPPORTED_DATA_RATES_MBPS],
    description: "链路速率，单位 Mbps。",
  };
}
