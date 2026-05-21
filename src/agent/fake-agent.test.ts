import { describe, expect, it } from "vitest";
import { runFakeTsnAgent } from "./fake-agent";
import { createProjectFromIntent } from "../domain/topology-factory";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createInitialWorkflowState } from "../project/project-state";

describe("fake tsn agent", () => {
  it("runs only the topology stage for an initial topology request", () => {
    const result = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.bundle).toBeUndefined();
    expect(result.events.map((event) => event.kind)).toContain("confirmation-required");
    expect(result.events.map((event) => event.skillName).filter(Boolean)).toEqual(["tsn-topology"]);
  });

  it("advances one stage at a time when the user confirms", () => {
    const topology = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);

    expect(timeSync.workflow.currentStep).toBe("time-sync");
    expect(timeSync.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    expect(timeSync.bundle).toBeUndefined();
    expect(timeSync.assistantText).toContain("默认假设全网已完成时间同步");
  });

  it("uses scenario configured time sync defaults", () => {
    const topology = runFakeTsnAgent(
      "我需要4个交换机，每个交换机连接5个端系统",
      undefined,
      createInitialWorkflowState("aerospace-onboard"),
    );
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);

    expect(timeSync.assistantText).toContain("默认采用全网统一时钟假设");
    expect(timeSync.assistantText).toContain("GM 选择、同步域和从端口关系");
  });

  it("confirms the final planning stage without rerunning it", () => {
    const topology = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);
    const planning = runFakeTsnAgent("继续", flow.project, flow.workflow);

    expect(planning.workflow.currentStep).toBe("planning-export");
    expect(planning.workflow.stages["planning-export"].status).toBe("waiting_confirmation");
    expect(planning.events.map((event) => event.kind)).toContain("confirmation-required");

    const confirmed = runFakeTsnAgent("继续", planning.project, planning.workflow);

    expect(confirmed.workflow.currentStep).toBe("planning-export");
    expect(confirmed.workflow.stages["planning-export"].status).toBe("confirmed");
    expect(confirmed.events.map((event) => event.kind)).not.toContain("confirmation-required");
    expect(confirmed.bundle?.artifacts.some((artifact) => artifact.path === "omnetpp.ini")).toBe(true);
    expect(confirmed.assistantText).toContain("已生成规划器输入和导出清单");
  });

  it("uses an explicit quick path when the user asks for direct generation", () => {
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统");

    const result = runFakeTsnAgent("直接生成", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(9);
    expect(result.workflow.currentStep).toBe("planning-export");
    expect(result.bundle?.artifacts.some((artifact) => artifact.path === "tsnagent/generated/network.ned")).toBe(true);
    expect(result.bundle?.artifacts.some((artifact) => artifact.path === "omnetpp.ini")).toBe(true);
    expect(result.assistantText).toContain("3 个交换机");
    expect(result.assistantText).toContain("3 个端系统");
  });

  it("keeps existing switch count when the user only changes host count", () => {
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统");

    const result = runFakeTsnAgent("每个交换机改成4个端系统", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.assistantText).toContain("3 个交换机");
    expect(result.assistantText).toContain("4 个端系统");
  });
});
