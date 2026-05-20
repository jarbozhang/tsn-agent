import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { validateCanonicalProject } from "../domain/validation";
import { exportNed } from "./ned-exporter";
import { exportPlannerInput } from "./planner-exporter";
import { exportReactFlowTopology } from "./react-flow-exporter";

export interface ExportedArtifact {
  path: string;
  purpose: string;
  content: string;
}

export interface ExportManifest {
  schemaVersion: "tsn-agent.export-manifest.v0";
  projectId: string;
  generatedAt: string;
  files: Array<{
    path: string;
    purpose: string;
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
      path: "network.ned",
      purpose: "INET/OMNeT++ 网络拓扑",
      content: exportNed(project),
    },
    {
      path: "react-flow-topology.json",
      purpose: "React Flow 拓扑展示数据",
      content: JSON.stringify(exportReactFlowTopology(project), null, 2),
    },
    {
      path: "flow_plan_1.json",
      purpose: "规划器输入",
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
    })),
  };

  return {
    artifacts: [
      ...artifacts,
      {
        path: "manifest.json",
        purpose: "导出文件清单",
        content: JSON.stringify(manifest, null, 2),
      },
    ],
    manifest,
  };
}
