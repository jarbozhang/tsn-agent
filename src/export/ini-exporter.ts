import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { NED_CONTRACT } from "./ned-contract";

export function exportOmnetppIni(project: CanonicalTsnProjectV0): string {
  const network = `${NED_CONTRACT.packageName}.${NED_CONTRACT.networkName}`;

  return [
    "[General]",
    `network = ${network}`,
    `sim-time-limit = ${suggestSimulationLimit(project)}`,
    "cmdenv-interactive = false",
    "cmdenv-express-mode = true",
    "include traffic.ini",
    "",
    "# TSN Agent 仅生成可加载拓扑和第一版 UDP 业务流配置。",
    "# gPTP、TAS/GCL、CBS、ATS、FRER 和规划结果回写由后续 inet-export skill 扩展。",
    "",
  ].join("\n");
}

function suggestSimulationLimit(project: CanonicalTsnProjectV0): string {
  const shortestPeriodUs = Math.min(...project.flows.map((flow) => flow.periodUs));

  if (!Number.isFinite(shortestPeriodUs) || shortestPeriodUs <= 0) {
    return "0s";
  }

  return `${Math.max(shortestPeriodUs * 4, 1_000)}us`;
}
