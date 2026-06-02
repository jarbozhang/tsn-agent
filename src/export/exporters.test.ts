import { describe, expect, it } from "vitest";
import { createProjectFromIntent, withFlowsFromIntent } from "../topology/topology-factory";
import { createArtifactBundle } from "./artifact-bundle";
import { exportOmnetppIni } from "./ini-exporter";
import { exportInetTrafficIni } from "./inet-traffic-exporter";
import { exportNed } from "./ned-exporter";
import { exportPlannerInput } from "./planner-exporter";
import { exportReactFlowTopology } from "./react-flow-exporter";
import { summarizePlannerResult, type PlannerResultSnapshot } from "../planner/planner-contract";

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

  it("exports planner input in planner service request shape", () => {
    const plannerInput = exportPlannerInput(project);
    const sourceConfig = plannerInput.sendData.source_config;
    const firstFlow = sourceConfig.flow_feature[0];
    const firstPath = firstFlow.path[0];
    const routeLinkIds = project.flows[0].routeLinkIds.map((linkId) => {
      const link = project.topology.links.find((candidate) => candidate.id === linkId);
      return link?.numericId;
    });
    const switchNode = sourceConfig.cfg_parameter.cfg_parameter.node.find((node) => node.node_type === "0");
    const endSystemNode = sourceConfig.cfg_parameter.cfg_parameter.node.find((node) => node.node_type === "1");

    expect(plannerInput.sendData.mode).toBe("time-trigger");
    expect(sourceConfig.cfg_parameter.cfg_parameter.node).toHaveLength(project.topology.nodes.length);
    expect(sourceConfig.flow_feature).toHaveLength(1);
    expect(sourceConfig.topo_feature).toHaveLength(project.topology.links.length);
    expect(switchNode).toMatchObject({
      system_clock: "125",
      rc_threshold: "8",
      port_num: String(project.topology.nodes[0].ports.length),
      node_type: "0",
    });
    expect(endSystemNode).toMatchObject({
      system_clock: "125",
      node_type: "1",
    });
    expect(firstFlow).toMatchObject({
      stream_id: project.flows[0].numericId,
      src_node: 4,
      dst_node: 19,
      path_number: 1,
      size: project.flows[0].frameSizeBytes,
      period: project.flows[0].periodUs,
    });
    expect(firstPath).toMatchObject({
      route: routeLinkIds,
      flow_type: "ST",
      ip_protocol: 17,
      redundant: 0,
      fl_api_flag: 0,
      delay_para: 100,
      fivetuple_mask: 0,
    });
    expect(firstPath.route.every((linkId) =>
      sourceConfig.topo_feature.some((link) => link.link_id === linkId)
    )).toBe(true);
  });

  it("exports requested video flow in planner input", () => {
    const projectWithVideo = withFlowsFromIntent(
      createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
        includeControlFlow: false,
      }),
      "两条流，一条视频流，一条控制流",
    );

    const plannerInput = exportPlannerInput(projectWithVideo);
    const flows = plannerInput.sendData.source_config.flow_feature;

    expect(flows).toHaveLength(2);
    expect(flows.map((stream) => stream.stream_id)).toEqual([1, 2]);
    expect(flows[1]).toMatchObject({
      stream_id: 2,
      size: 50 * 1024,
      period: 33_333,
      src_node: 3,
      dst_node: 6,
    });
    expect(flows[1].path[0]).toMatchObject({
      src_ip: "10.0.1.2",
      dst_ip: "10.0.2.2",
      src_port: 25564,
      dst_port: 26029,
      dst_mac: "00:1B:44:11:3A:05",
    });
  });

  it("rejects planner input when project has no flows", () => {
    const projectWithoutFlows = createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
      includeControlFlow: false,
    });

    expect(() => exportPlannerInput(projectWithoutFlows)).toThrow("project has no flows");
  });

  it("rejects planner input when a flow references a missing route link", () => {
    const brokenProject = {
      ...project,
      flows: [
        {
          ...project.flows[0],
          routeLinkIds: ["missing-link"],
        },
      ],
    };

    expect(() => exportPlannerInput(brokenProject)).toThrow("flow flow-control-1 references missing route link missing-link");
  });

  it("rejects planner input for non-ST flows unsupported by the first planner API version", () => {
    const projectWithBestEffort = withFlowsFromIntent(
      createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
        includeControlFlow: false,
      }),
      "我还需要一条BE流",
    );

    expect(() => exportPlannerInput(projectWithBestEffort)).toThrow("unsupported flow type BE");
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

  it("adds real planner output and INET GCL trace artifacts only when result snapshot exists", () => {
    const snapshot = createPlannerResultSnapshot(project.flows[0].numericId);
    const bundle = createArtifactBundle(project, {
      plannerRequest: exportPlannerInput(project),
      plannerResult: snapshot,
    });
    const plannerOutput = bundle.artifacts.find((artifact) => artifact.path === "planner/flow_plan_result_1.json");
    const gclJson = bundle.artifacts.find((artifact) => artifact.path === "simulation/inet/planner-gcl.json");
    const gclNotes = bundle.artifacts.find((artifact) => artifact.path === "simulation/inet/planner-gcl-notes.md");

    expect(bundle.artifacts.map((artifact) => artifact.path)).toContain("planner/planner_request_1.json");
    expect(plannerOutput).toMatchObject({
      purpose: "planner-output",
      observedExternal: true,
    });
    expect(plannerOutput?.content).toContain('"solution_json"');
    expect(gclJson?.content).toContain('"planId": "plan-1"');
    expect(gclJson?.content).toContain('"canonicalLinkId": "link-0"');
    expect(gclJson?.content).toContain('"flowName": "控制流-1"');
    expect(gclNotes?.content).toContain("尚未声明为可直接运行的 TAS gate schedule");
    expect(bundle.manifest.files).toContainEqual(
      expect.objectContaining({
        path: "planner/flow_plan_result_1.json",
        purpose: "planner-output",
        observedExternal: true,
      }),
    );
  });
});

function createPlannerResultSnapshot(streamId: number): PlannerResultSnapshot {
  const sourceOutputs = {
    solution_json: [
      {
        link_id: 0,
        gcl_entries: [
          {
            interval: 32,
            state: "open",
            stream_id: streamId,
          },
        ],
      },
    ],
    tsnlight_plan_cfg_json: {
      network_plan_cfg: {
        node: [],
      },
    },
  };

  return {
    planId: "plan-1",
    state: "succeeded",
    sourceOutputs,
    outputFingerprints: {
      solution_json: {
        file_name: "solution.json",
        size_bytes: 128,
        sha256: "a".repeat(64),
        mtime_ns: 1,
      },
    },
    receivedAt: "2026-05-22T10:00:00.000Z",
    summary: summarizePlannerResult(sourceOutputs, {
      solution_json: {
        file_name: "solution.json",
        size_bytes: 128,
        sha256: "a".repeat(64),
        mtime_ns: 1,
      },
    }),
  };
}
