import { describe, expect, it } from "vitest";
import { findPortIndex, groupArtifacts, artifactGroupFallbackLabels } from "./index";
import type { ExportedArtifact } from "../../../export/artifact-bundle";

describe("workspace-pane helpers", () => {
  it("findPortIndex returns index when port exists", () => {
    const node = { ports: [{ id: "p1", index: 0 }, { id: "p2", index: 1 }] };
    expect(findPortIndex(node, "p2")).toBe(1);
  });

  it("findPortIndex returns 无 when port absent", () => {
    expect(findPortIndex({ ports: [] }, "p1")).toBe("无");
  });

  it("groupArtifacts returns empty array when no artifacts", () => {
    expect(groupArtifacts([])).toEqual([]);
  });

  it("groupArtifacts groups by classification.group", () => {
    const artifacts: ExportedArtifact[] = [
      { path: "workspace/file.json", content: "{}", label: "Workspace 1", purpose: "ned-template" } as unknown as ExportedArtifact,
    ];
    const groups = groupArtifacts(artifacts);
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  it("artifactGroupFallbackLabels covers all groups", () => {
    expect(artifactGroupFallbackLabels.workspace).toBeDefined();
    expect(artifactGroupFallbackLabels.planner).toBeDefined();
    expect(artifactGroupFallbackLabels["simulation-inet"]).toBeDefined();
    expect(artifactGroupFallbackLabels.manifest).toBeDefined();
    expect(artifactGroupFallbackLabels.legacy).toBeDefined();
  });
});
