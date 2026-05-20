import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "../export/artifact-bundle";
import { createProjectState, withProjectBundle } from "./project-state";
import { appendSnapshot, restoreSnapshot } from "./snapshots";

describe("project state snapshots", () => {
  it("captures and restores step snapshots without mutating later state", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");
    const bundle = createArtifactBundle(project);
    const state = withProjectBundle(createProjectState({ sessionId: "session-1", project }), bundle);

    const snapshotted = appendSnapshot(state, {
      step: "topology",
      summary: "拓扑已生成",
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    const changed = {
      ...snapshotted,
      project: createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统"),
      bundle: undefined,
    };

    const restored = restoreSnapshot(changed, snapshotted.snapshots[0].id);

    expect(restored.project.topology.nodes).toHaveLength(24);
    expect(restored.bundle?.artifacts.map((artifact) => artifact.path)).toContain("tsnagent/generated/network.ned");
    expect(restored.bundle?.artifacts.map((artifact) => artifact.path)).toContain("omnetpp.ini");
    expect(restored.activeSnapshotId).toBe(snapshotted.snapshots[0].id);
  });

  it("rejects missing snapshots explicitly", () => {
    const state = createProjectState({
      sessionId: "session-1",
      project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"),
    });

    expect(() => restoreSnapshot(state, "missing-snapshot")).toThrow("does not exist");
  });
});
