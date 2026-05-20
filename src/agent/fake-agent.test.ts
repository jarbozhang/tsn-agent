import { describe, expect, it } from "vitest";
import { runFakeTsnAgent } from "./fake-agent";

describe("fake tsn agent", () => {
  it("runs the topology, flow template, and export steps", () => {
    const result = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.events.map((event) => event.skillName).filter(Boolean)).toEqual([
      "tsn-topology",
      "tsn-topology",
      "tsn-flow-template",
      "tsn-export",
    ]);
    expect(result.bundle.artifacts.some((artifact) => artifact.path === "network.ned")).toBe(true);
  });
});
