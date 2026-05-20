import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "./artifact-bundle";
import { exportNed } from "./ned-exporter";
import { exportPlannerInput } from "./planner-exporter";
import { exportReactFlowTopology } from "./react-flow-exporter";

describe("exporters", () => {
  const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");

  it("exports a minimal INET NED network", () => {
    const ned = exportNed(project);

    expect(ned).toContain("package tsnagent.generated;");
    expect(ned).toContain("network TsnAgentNetwork");
    expect(ned).toContain("sw1: EthernetSwitch");
    expect(ned).toContain("es1_1: StandardHost");
  });

  it("exports React Flow topology JSON", () => {
    const topology = exportReactFlowTopology(project);

    expect(topology.nodes).toHaveLength(24);
    expect(topology.edges).toHaveLength(23);
  });

  it("exports planner input with the existing stream_info shape", () => {
    const plannerInput = exportPlannerInput(project);

    expect(plannerInput.base.name).toBe(project.name);
    expect(plannerInput.stream_info).toHaveLength(1);
    expect(plannerInput.stream_info[0].path[0]).toMatchObject({
      flow_type: "ST",
      ip_protocol: 17,
      pcp: "6",
    });
  });

  it("creates the MVP artifact bundle", () => {
    const bundle = createArtifactBundle(project);

    expect(bundle.artifacts.map((artifact) => artifact.path)).toEqual([
      "network.ned",
      "react-flow-topology.json",
      "flow_plan_1.json",
      "manifest.json",
    ]);
  });
});
