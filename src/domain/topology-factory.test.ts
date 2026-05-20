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

  it("creates a canonical line topology with one control flow", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(20);
    expect(project.topology.links).toHaveLength(23);
    expect(project.flows).toHaveLength(1);
    expect(project.flows[0].routeLinkIds).toEqual(["link-0", "link-20", "link-21", "link-22", "link-15"]);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });
});
