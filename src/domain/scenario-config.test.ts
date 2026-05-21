import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENARIO_CONFIG_ID,
  SCENARIO_CONFIGS,
  WORKFLOW_STEPS,
  getScenarioConfig,
  resolveScenarioConfig,
} from "./scenario-config";

describe("scenario config", () => {
  it("uses the generic TSN config by default", () => {
    const config = getScenarioConfig();

    expect(config.id).toBe(DEFAULT_SCENARIO_CONFIG_ID);
    expect(config.stageLabels.topology).toBe("拓扑");
    expect(config.flowTemplates[0].name).toBe("控制流-1");
  });

  it("defines labels for every stable workflow step", () => {
    for (const config of Object.values(SCENARIO_CONFIGS)) {
      expect(Object.keys(config.stageLabels).sort()).toEqual([...WORKFLOW_STEPS].sort());
    }
  });

  it("resolves the typical aerospace onboard config", () => {
    const config = getScenarioConfig("aerospace-onboard");

    expect(config.displayName).toContain("箭载");
    expect(config.stageLabels["flow-template"]).toBe("关键业务流");
    expect(config.flowTemplates[0].name).toBe("飞控控制流-1");
  });

  it("falls back to the generic config for unknown ids with a warning", () => {
    const resolution = resolveScenarioConfig("missing-config");

    expect(resolution.config.id).toBe("generic-tsn");
    expect(resolution.fallback).toBe(true);
    expect(resolution.warning).toContain("missing-config");
  });
});
