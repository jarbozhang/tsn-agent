import { describe, expect, it } from "vitest";
import { runFakeTsnAgent } from "./fake-agent";
import { createProjectFromIntent } from "../domain/topology-factory";
import { isEndSystem, isSwitch } from "../domain/canonical";

describe("fake tsn agent", () => {
  it("runs the topology, flow template, and export steps", () => {
    const result = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.events.map((event) => event.skillName).filter(Boolean)).toEqual([
      "tsn-topology",
      "tsn-topology",
      "tsn-flow-template",
      "tsn-export",
    ]);
    expect(result.bundle.artifacts.some((artifact) => artifact.path === "tsnagent/generated/network.ned")).toBe(true);
    expect(result.bundle.artifacts.some((artifact) => artifact.path === "omnetpp.ini")).toBe(true);
  });

  it("reuses the previous project when the user confirms generation without restating topology", () => {
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统");

    const result = runFakeTsnAgent("直接生成", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(9);
    expect(result.assistantText).toContain("3 个交换机");
    expect(result.assistantText).toContain("3 个端系统");
  });

  it("keeps existing switch count when the user only changes host count", () => {
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统");

    const result = runFakeTsnAgent("每个交换机改成4个端系统", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(result.assistantText).toContain("3 个交换机");
    expect(result.assistantText).toContain("4 个端系统");
  });
});
