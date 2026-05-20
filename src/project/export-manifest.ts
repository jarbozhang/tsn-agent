import type { ArtifactBundle, ExportManifest } from "../export/artifact-bundle";

export type ManifestValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateExportManifest(bundle: ArtifactBundle): ManifestValidationResult {
  const errors: string[] = [];
  const artifactPaths = new Set(bundle.artifacts.map((artifact) => artifact.path));
  const manifestPaths = new Set(bundle.manifest.files.map((file) => file.path));

  for (const artifact of bundle.artifacts) {
    if (artifact.path === "manifest.json") {
      continue;
    }

    if (!manifestPaths.has(artifact.path)) {
      errors.push(`${artifact.path} is missing from manifest.`);
    }
  }

  for (const file of bundle.manifest.files) {
    if (!file.observedExternal && !artifactPaths.has(file.path)) {
      errors.push(`${file.path} is listed in manifest but no artifact content exists.`);
    }

    if (file.purpose === "planner-output" && !file.observedExternal) {
      errors.push(`${file.path} must be marked observedExternal when purpose is planner-output.`);
    }
  }

  if (manifestPaths.has("flow_plan_result_1.json")) {
    const resultFile = bundle.manifest.files.find((file) => file.path === "flow_plan_result_1.json");

    if (resultFile?.purpose !== "planner-output" || resultFile.observedExternal !== true) {
      errors.push("flow_plan_result_1.json must be classified as observed external planner output.");
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function withObservedPlannerResult(
  manifest: ExportManifest,
  path = "flow_plan_result_1.json",
): ExportManifest {
  if (manifest.files.some((file) => file.path === path)) {
    return manifest;
  }

  return {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path,
        purpose: "planner-output",
        label: "规划器输出",
        observedExternal: true,
      },
    ],
  };
}
