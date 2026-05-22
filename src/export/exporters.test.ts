import { describe, expect, it } from "vitest";
import { createProjectFromIntent, withFlowsFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "./artifact-bundle";
import { exportOmnetppIni } from "./ini-exporter";
import { exportInetTrafficIni } from "./inet-traffic-exporter";
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
    expect(ini).toContain("include traffic.ini");
    expect(ini).toContain("gPTP、TAS/GCL");
  });

  it("exports first-pass INET UDP traffic apps", () => {
    const projectWithVideo = withFlowsFromIntent(
      createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
        includeControlFlow: false,
      }),
      "两条流，一条视频流，一条控制流",
    );

    const traffic = exportInetTrafficIni(projectWithVideo);

    expect(traffic).toContain('*.es1_1.app[0].typename = "UdpSourceApp"');
    expect(traffic).toContain('*.es1_1.app[0].io.destAddress = "es2_1"');
    expect(traffic).toContain(`*.es1_1.app[0].io.destPort = ${projectWithVideo.flows[0].destination.udpPort}`);
    expect(traffic).toContain(`*.es1_1.app[0].source.packetLength = ${projectWithVideo.flows[0].frameSizeBytes}B`);
    expect(traffic).toContain(`*.es1_1.app[0].source.productionInterval = ${projectWithVideo.flows[0].periodUs}us`);
    expect(traffic).toContain('*.es2_1.app[0].typename = "UdpSinkApp"');
    expect(traffic).toContain(`*.es2_1.app[0].io.localPort = ${projectWithVideo.flows[0].destination.udpPort}`);
    expect(traffic).toContain('*.es1_2.app[0].typename = "UdpSourceApp"');
    expect(traffic).toContain('*.es2_2.app[0].typename = "UdpSinkApp"');
    expect(traffic).toContain("no gPTP, TAS/GCL, CBS");
  });

  it("rejects INET traffic when a flow references a missing endpoint node", () => {
    const brokenProject = {
      ...project,
      flows: [
        {
          ...project.flows[0],
          source: {
            ...project.flows[0].source,
            nodeId: "missing-node",
          },
        },
      ],
    };

    expect(() => exportInetTrafficIni(brokenProject)).toThrow("missing source node missing-node");
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

  it("exports requested video flow in planner input", () => {
    const projectWithVideo = withFlowsFromIntent(
      createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
        includeControlFlow: false,
      }),
      "两条流，一条视频流，一条控制流",
    );

    const plannerInput = exportPlannerInput(projectWithVideo);

    expect(plannerInput.stream_info).toHaveLength(2);
    expect(plannerInput.stream_info.map((stream) => stream.stream_name)).toEqual(["控制流-1", "视频流-1"]);
    expect(plannerInput.stream_info[1]).toMatchObject({
      stream_id: 2,
      stream_name: "视频流-1",
      size: String(50 * 1024),
      period: "33333",
    });
    expect(plannerInput.stream_info[1].path[0]).toMatchObject({
      src_ip: "10.0.1.2",
      dst_ip: "10.0.2.2",
      src_port: "25564",
      dst_port: "26029",
      pcp: "5",
    });
  });

  it("creates the MVP artifact bundle", () => {
    const bundle = createArtifactBundle(project);

    expect(bundle.artifacts.map((artifact) => artifact.path)).toEqual([
      "simulation/inet/tsnagent/generated/network.ned",
      "simulation/inet/omnetpp.ini",
      "simulation/inet/traffic.ini",
      "workspace/react-flow-topology.json",
      "planner/flow_plan_1.json",
      "manifest.json",
    ]);
    expect(bundle.manifest.files).toEqual([
      expect.objectContaining({ path: "simulation/inet/tsnagent/generated/network.ned", purpose: "simulation-inet" }),
      expect.objectContaining({ path: "simulation/inet/omnetpp.ini", purpose: "simulation-inet" }),
      expect.objectContaining({ path: "simulation/inet/traffic.ini", purpose: "simulation-inet" }),
      expect.objectContaining({ path: "workspace/react-flow-topology.json", purpose: "workspace-visualization" }),
      expect.objectContaining({ path: "planner/flow_plan_1.json", purpose: "planner-input" }),
    ]);
    expect(bundle.artifacts.some((artifact) => artifact.path === "planner/flow_plan_result_1.json")).toBe(false);
  });
});
