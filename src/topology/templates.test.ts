import { describe, expect, it } from "vitest";
import { describeTemplates } from "./templates";

describe("topology templates", () => {
  it("describes the deterministic P0 template catalog", () => {
    const catalog = describeTemplates();

    expect(catalog.summary).toEqual({
      templateCount: 3,
      templateIds: ["generic-line", "generic-ring", "aerospace-redundant"],
    });
    expect(catalog.templates.map((template) => template.id)).toEqual([
      "generic-line",
      "generic-ring",
      "aerospace-redundant",
    ]);
    expect(catalog.templates[0].params.map((param) => param.name)).toEqual([
      "switchCount",
      "endSystemsPerSwitch",
      "dataRateMbps",
    ]);
  });
});
