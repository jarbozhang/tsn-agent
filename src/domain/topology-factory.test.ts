import { describe, expect, it } from "vitest";
import { createProjectFromIntent, parseTopologyIntent } from "./topology-factory";
import { isEndSystem, isSwitch } from "./canonical";
import { validateCanonicalProject } from "./validation";

describe("topology factory", () => {
  it("parses a beginner topology request", () => {
    expect(parseTopologyIntent("我需要4个交换机，每个交换机连接5个端系统")).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 5,
    });
  });

  it("uses fallback topology values for partial edit requests", () => {
    expect(parseTopologyIntent("每个交换机改成4个端系统", { switchCount: 3, endSystemsPerSwitch: 3 })).toEqual({
      switchCount: 3,
      endSystemsPerSwitch: 4,
    });
  });

  it("creates a canonical line topology with one control flow", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(20);
    expect(project.topology.links).toHaveLength(23);
    expect(project.flows).toHaveLength(1);
    expect(project.flows[0].routeLinkIds).toEqual(["link-0", "link-20", "link-21", "link-22", "link-15"]);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("can use scenario config defaults and flow template labels", () => {
    const project = createProjectFromIntent("请生成一个典型场景拓扑", undefined, {
      scenarioConfigId: "aerospace-onboard",
    });

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(20);
    expect(project.flows[0].name).toBe("飞控控制流-1");
    expect(project.simulationHints.defaultDataRateMbps).toBe(1_000);
  });

  it("falls back to generic scenario defaults for unknown config ids", () => {
    const project = createProjectFromIntent("请生成一个默认拓扑", undefined, {
      scenarioConfigId: "unknown-config",
    });

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.flows[0].name).toBe("控制流-1");
  });
});
