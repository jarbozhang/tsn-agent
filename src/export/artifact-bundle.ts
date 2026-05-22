import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { validateCanonicalProject } from "../domain/validation";
import { exportOmnetppIni } from "./ini-exporter";
import { exportInetTrafficIni } from "./inet-traffic-exporter";
import { NED_CONTRACT } from "./ned-contract";
import { exportNed } from "./ned-exporter";
import { exportPlannerInput } from "./planner-exporter";
import { exportReactFlowTopology } from "./react-flow-exporter";

export type ArtifactPurpose =
  | "simulation-inet"
  | "workspace-visualization"
  | "planner-input"
  | "planner-output"
  | "manifest";

export interface ExportedArtifact {
  path: string;
  purpose: ArtifactPurpose;
  label: string;
  observedExternal?: boolean;
  content: string;
}

export interface ExportManifest {
  schemaVersion: "tsn-agent.export-manifest.v0";
  projectId: string;
  generatedAt: string;
  files: Array<{
    path: string;
    purpose: ArtifactPurpose;
    label: string;
    observedExternal?: boolean;
  }>;
}

export interface ArtifactBundle {
  artifacts: ExportedArtifact[];
  manifest: ExportManifest;
}

export function createArtifactBundle(project: CanonicalTsnProjectV0): ArtifactBundle {
  const validation = validateCanonicalProject(project);

  if (!validation.ok) {
    throw new Error(`Cannot export invalid project: ${validation.errors.join("; ")}`);
  }

  const artifacts: ExportedArtifact[] = [
    {
      path: NED_CONTRACT.artifactPath,
      purpose: "simulation-inet",
      label: "INET/OMNeT++ 网络拓扑",
      content: exportNed(project),
    },
    {
      path: "simulation/inet/omnetpp.ini",
      purpose: "simulation-inet",
      label: "INET/OMNeT++ 入口配置",
      content: exportOmnetppIni(project),
    },
    {
      path: "simulation/inet/traffic.ini",
      purpose: "simulation-inet",
      label: "INET/OMNeT++ UDP 业务流配置",
      content: exportInetTrafficIni(project),
    },
    {
      path: "workspace/react-flow-topology.json",
      purpose: "workspace-visualization",
      label: "React Flow 拓扑展示数据",
      content: JSON.stringify(exportReactFlowTopology(project), null, 2),
    },
    {
      path: "planner/flow_plan_1.json",
      purpose: "planner-input",
      label: "规划器输入",
      content: JSON.stringify(exportPlannerInput(project), null, 2),
    },
  ];
  const manifest: ExportManifest = {
    schemaVersion: "tsn-agent.export-manifest.v0",
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    files: artifacts.map((artifact) => ({
      path: artifact.path,
      purpose: artifact.purpose,
      label: artifact.label,
      observedExternal: artifact.observedExternal,
    })),
  };

  return {
    artifacts: [
      ...artifacts,
      {
        path: "manifest.json",
        purpose: "manifest",
        label: "导出文件清单",
        content: JSON.stringify(manifest, null, 2),
      },
    ],
    manifest,
  };
}
