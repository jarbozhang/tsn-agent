import path from "node:path";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import type { ArtifactBundle } from "../export/artifact-bundle";
import { validateExportManifest } from "./export-manifest";

export interface ProjectWriterOptions {
  repoRoot?: string;
  homeDir?: string;
  appConfigDir?: string;
}

export interface WriteProjectResult {
  outputDir: string;
  writtenFiles: string[];
}

const DANGEROUS_ROOTS = new Set([
  path.parse(process.cwd()).root,
  "/",
]);

export async function writeProjectArtifacts(
  outputDir: string,
  bundle: ArtifactBundle,
  options: ProjectWriterOptions = {},
): Promise<WriteProjectResult> {
  const validation = validateExportManifest(bundle);

  if (!validation.ok) {
    throw new Error(`Export manifest is invalid: ${validation.errors.join("; ")}`);
  }

  const safeOutputDir = await assertSafeProjectPath(outputDir, options);

  await mkdir(safeOutputDir, { recursive: true });

  for (const artifact of bundle.artifacts) {
    const destination = resolveArtifactPath(safeOutputDir, artifact.path);
    const tempPath = `${destination}.tmp-${Date.now()}`;

    await assertArtifactParentsAreNotSymlinks(safeOutputDir, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(tempPath, artifact.content, "utf8");
    await rename(tempPath, destination);
  }

  return {
    outputDir: safeOutputDir,
    writtenFiles: bundle.artifacts.map((artifact) => artifact.path),
  };
}

export async function assertSafeProjectPath(
  outputDir: string,
  options: ProjectWriterOptions = {},
): Promise<string> {
  if (!path.isAbsolute(outputDir)) {
    throw new Error("Project export path must be absolute.");
  }

  const normalized = path.resolve(outputDir);
  const protectedParents = [
    options.repoRoot,
    options.appConfigDir,
    process.cwd(),
  ].filter(isString);
  const exactForbiddenPaths = [
    ...protectedParents,
    options.homeDir,
    path.parse(normalized).root,
  ].filter(isString);

  if (DANGEROUS_ROOTS.has(normalized) || exactForbiddenPaths.some((forbidden) => samePath(normalized, path.resolve(forbidden)))) {
    throw new Error(`Refusing to export project artifacts to dangerous path: ${normalized}`);
  }

  if (protectedParents.some((forbidden) => isParentOrSame(path.resolve(forbidden), normalized))) {
    throw new Error(`Refusing to export project artifacts inside protected path: ${normalized}`);
  }

  await assertTargetIsNotSymlink(normalized);

  return normalized;
}

function resolveArtifactPath(baseDir: string, artifactPath: string): string {
  if (path.isAbsolute(artifactPath)) {
    throw new Error(`Artifact path must be relative: ${artifactPath}`);
  }

  if (artifactPath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Artifact path escapes project directory: ${artifactPath}`);
  }

  const resolved = path.resolve(baseDir, artifactPath);

  if (!isParentOrSame(baseDir, resolved)) {
    throw new Error(`Artifact path escapes project directory: ${artifactPath}`);
  }

  return resolved;
}

function isParentOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

function isString(value: string | undefined): value is string {
  return Boolean(value);
}

async function assertTargetIsNotSymlink(targetPath: string): Promise<void> {
  try {
    const stat = await lstat(targetPath);

    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to export project artifacts through symlink: ${targetPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("through symlink")) {
      throw error;
    }
  }
}

async function assertArtifactParentsAreNotSymlinks(baseDir: string, destination: string): Promise<void> {
  const relativeParent = path.relative(baseDir, path.dirname(destination));
  const segments = relativeParent.split(path.sep).filter(Boolean);
  let current = baseDir;

  for (const segment of segments) {
    current = path.join(current, segment);

    try {
      const stat = await lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to export project artifacts through symlink: ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("through symlink")) {
        throw error;
      }
    }
  }
}
