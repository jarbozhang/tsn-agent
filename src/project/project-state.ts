import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { ArtifactBundle } from "../export/artifact-bundle";

export type ProjectStep = "topology" | "flow-template" | "export";

export interface ProjectStepSnapshot {
  id: string;
  step: ProjectStep;
  createdAt: string;
  summary: string;
  project: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
}

export interface ProjectState {
  sessionId: string;
  project: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
  snapshots: ProjectStepSnapshot[];
  activeSnapshotId?: string;
}

export function createProjectState(input: {
  sessionId: string;
  project: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
}): ProjectState {
  return {
    sessionId: input.sessionId,
    project: input.project,
    bundle: input.bundle,
    snapshots: [],
  };
}

export function withProjectBundle(state: ProjectState, bundle: ArtifactBundle): ProjectState {
  return {
    ...state,
    bundle,
  };
}
