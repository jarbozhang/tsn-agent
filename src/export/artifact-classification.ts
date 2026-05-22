import type { ArtifactPurpose, ExportedArtifact } from "./artifact-bundle";

export type ArtifactGroupId = "workspace" | "planner" | "simulation-inet" | "manifest" | "legacy";

export interface ArtifactClassification {
  group: ArtifactGroupId;
  groupLabel: string;
  roleLabel: string;
  isEntrypoint: boolean;
}

export function classifyArtifact(artifact: Pick<ExportedArtifact, "path" | "purpose" | "observedExternal">): ArtifactClassification {
  const group = inferArtifactGroup(artifact.path, artifact.purpose);
  const roleLabel = inferArtifactRole(artifact);

  return {
    group,
    groupLabel: groupLabels[group],
    roleLabel,
    isEntrypoint: artifact.path === "simulation/inet/omnetpp.ini" || artifact.path === "omnetpp.ini",
  };
}

function inferArtifactGroup(path: string, purpose: ArtifactPurpose): ArtifactGroupId {
  if (path.startsWith("workspace/")) {
    return "workspace";
  }

  if (path.startsWith("planner/")) {
    return "planner";
  }

  if (path.startsWith("simulation/inet/")) {
    return "simulation-inet";
  }

  if (path === "manifest.json" || purpose === "manifest") {
    return "manifest";
  }

  if (purpose === "workspace-visualization") {
    return "workspace";
  }

  if (purpose === "planner-input" || purpose === "planner-output") {
    return "planner";
  }

  if (purpose === "simulation-inet") {
    return "simulation-inet";
  }

  return "legacy";
}

function inferArtifactRole(artifact: Pick<ExportedArtifact, "path" | "purpose" | "observedExternal">): string {
  if (artifact.path === "simulation/inet/omnetpp.ini" || artifact.path === "omnetpp.ini") {
    return "INET 入口";
  }

  if (artifact.path === "simulation/inet/traffic.ini") {
    return "UDP 业务流配置";
  }

  if (artifact.purpose === "planner-input") {
    return "规划器输入";
  }

  if (artifact.purpose === "planner-output" || artifact.observedExternal) {
    return "外部观测输出";
  }

  if (artifact.purpose === "workspace-visualization") {
    return "工作台展示数据";
  }

  if (artifact.purpose === "manifest") {
    return "导出清单";
  }

  return artifact.purpose;
}

const groupLabels: Record<ArtifactGroupId, string> = {
  workspace: "工作台展示",
  planner: "外部规划器",
  "simulation-inet": "INET 仿真输入",
  manifest: "清单",
  legacy: "旧版文件",
};
