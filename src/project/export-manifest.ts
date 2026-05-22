import type { ArtifactBundle, ExportManifest } from "../export/artifact-bundle";

export type ManifestValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateExportManifest(bundle: ArtifactBundle): ManifestValidationResult {
  const errors: string[] = [];
  const artifactPaths = new Set<string>();
  const manifestPaths = new Set<string>();

  for (const artifact of bundle.artifacts) {
    if (artifactPaths.has(artifact.path)) {
      errors.push(`${artifact.path} is duplicated in artifacts.`);
    }

    artifactPaths.add(artifact.path);
  }

  for (const file of bundle.manifest.files) {
    if (manifestPaths.has(file.path)) {
      errors.push(`${file.path} is duplicated in manifest.`);
    }

    manifestPaths.add(file.path);
  }

  if (!artifactPaths.has("manifest.json")) {
    errors.push("manifest.json artifact content is required.");
  }

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

    if (file.purpose === "planner-output" && !isAllowedPlannerOutputPath(file.path)) {
      errors.push(`${file.path} is not an allowed planner output path.`);
    }
  }

  for (const resultPath of ALLOWED_PLANNER_OUTPUT_PATHS) {
    if (!manifestPaths.has(resultPath)) {
      continue;
    }

    const resultFile = bundle.manifest.files.find((file) => file.path === resultPath);

    if (resultFile?.purpose !== "planner-output" || resultFile.observedExternal !== true) {
      errors.push(`${resultPath} must be classified as observed external planner output.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

const ALLOWED_PLANNER_OUTPUT_PATHS = ["flow_plan_result_1.json", "planner/flow_plan_result_1.json"] as const;

function isAllowedPlannerOutputPath(path: string): boolean {
  return (ALLOWED_PLANNER_OUTPUT_PATHS as readonly string[]).includes(path);
}

export function withObservedPlannerResult(
  manifest: ExportManifest,
  path = "planner/flow_plan_result_1.json",
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
