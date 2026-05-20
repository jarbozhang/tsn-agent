import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "./artifact-bundle";
import { exportOmnetppIni } from "./ini-exporter";
import { exportNed } from "./ned-exporter";
import { exportPlannerInput } from "./planner-exporter";
import { exportReactFlowTopology } from "./react-flow-exporter";

describe("exporters", () => {
  const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");

  it("exports a minimal INET NED network", () => {
    const ned = exportNed(project);

    expect(ned).toContain("package tsnagent.generated;");
    expect(ned).toContain("import inet.networks.base.TsnNetworkBase;");
    expect(ned).toContain("import inet.node.ethernet.EthernetLink;");
    expect(ned).toContain("import inet.node.tsn.TsnDevice;");
    expect(ned).toContain("import inet.node.tsn.TsnSwitch;");
    expect(ned).toContain("network TsnAgentNetwork extends TsnNetworkBase");
    expect(ned).toContain("*.eth[*].bitrate = default(1000Mbps);");
    expect(ned).toContain("sw1: TsnSwitch");
    expect(ned).toContain("es1_1: TsnDevice");
    expect(ned).toContain("EthernetLink { datarate = 1000Mbps; }");
  });

  it("exports a minimal INET omnetpp.ini", () => {
    const ini = exportOmnetppIni(project);

    expect(ini).toContain("[General]");
    expect(ini).toContain("network = tsnagent.generated.TsnAgentNetwork");
    expect(ini).toContain("sim-time-limit = 1000us");
    expect(ini).toContain("cmdenv-interactive = false");
    expect(ini).toContain("gPTP、TAS/GCL");
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
      "tsnagent/generated/network.ned",
      "omnetpp.ini",
      "react-flow-topology.json",
      "flow_plan_1.json",
      "manifest.json",
    ]);
    expect(bundle.manifest.files).toEqual([
      expect.objectContaining({ path: "tsnagent/generated/network.ned", purpose: "simulation-inet" }),
      expect.objectContaining({ path: "omnetpp.ini", purpose: "simulation-inet" }),
      expect.objectContaining({ path: "react-flow-topology.json", purpose: "workspace-visualization" }),
      expect.objectContaining({ path: "flow_plan_1.json", purpose: "planner-input" }),
    ]);
    expect(bundle.artifacts.some((artifact) => artifact.path === "flow_plan_result_1.json")).toBe(false);
  });
});
