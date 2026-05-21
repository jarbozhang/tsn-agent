import type { ArtifactBundle } from "../export/artifact-bundle";
import type { ProjectState, ProjectStep } from "./project-state";

export function createStepSnapshot(
  state: ProjectState,
  input: {
    step: ProjectStep;
    summary: string;
    createdAt?: string;
  },
) {
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    id: createSnapshotId(input.step, createdAt),
    step: input.step,
    createdAt,
    summary: input.summary,
    project: structuredClone(state.project),
    bundle: state.bundle ? structuredClone(state.bundle) : undefined,
    workflow: structuredClone(state.workflow),
  };
}

export function appendSnapshot(
  state: ProjectState,
  input: {
    step: ProjectStep;
    summary: string;
    createdAt?: string;
  },
): ProjectState {
  const snapshot = createStepSnapshot(state, input);

  return {
    ...state,
    snapshots: [...state.snapshots, snapshot],
    activeSnapshotId: snapshot.id,
  };
}

export function restoreSnapshot(state: ProjectState, snapshotId: string): ProjectState {
  const snapshot = state.snapshots.find((candidate) => candidate.id === snapshotId);

  if (!snapshot) {
    throw new Error(`Snapshot ${snapshotId} does not exist.`);
  }

  return {
    ...state,
    project: structuredClone(snapshot.project),
    bundle: snapshot.bundle ? structuredClone(snapshot.bundle) as ArtifactBundle : undefined,
    workflow: structuredClone(snapshot.workflow),
    activeSnapshotId: snapshot.id,
  };
}

function createSnapshotId(step: ProjectStep, createdAt: string): string {
  return `snapshot-${step}-${createdAt.replace(/[^0-9A-Za-z]/g, "")}`;
}
