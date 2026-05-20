import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ArtifactBundle } from "../export/artifact-bundle";

export interface ProjectExportResult {
  mode: "browser-preview" | "tauri";
  outputDir: string;
  writtenFiles: string[];
}

export interface SuggestedProjectExportDirectoryRequest {
  sessionId: string;
}

interface TauriWriteProjectArtifactsResult {
  outputDir: string;
  writtenFiles: string[];
}

export async function exportProjectBundle(
  bundle: ArtifactBundle,
  outputDir?: string,
): Promise<ProjectExportResult> {
  if (!isTauriRuntime()) {
    return {
      mode: "browser-preview",
      outputDir: "browser-preview",
      writtenFiles: bundle.artifacts.map((artifact) => artifact.path),
    };
  }

  if (!outputDir?.trim()) {
    throw new Error("Tauri 导出需要提供绝对项目目录。");
  }

  const result = await invoke<TauriWriteProjectArtifactsResult>("write_project_artifacts", {
    request: {
      outputDir: outputDir.trim(),
      artifacts: bundle.artifacts.map((artifact) => ({
        path: artifact.path,
        purpose: artifact.purpose,
        label: artifact.label,
        observedExternal: artifact.observedExternal,
        content: artifact.content,
      })),
    },
  });

  return {
    mode: "tauri",
    outputDir: result.outputDir,
    writtenFiles: result.writtenFiles,
  };
}

export async function suggestProjectExportDirectory(
  request: SuggestedProjectExportDirectoryRequest,
): Promise<string | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  return invoke<string>("suggest_project_export_dir", {
    request,
  });
}

export async function selectProjectExportDirectory(defaultPath?: string): Promise<string | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const selected = await open({
    directory: true,
    multiple: false,
    canCreateDirectories: true,
    title: "选择 TSN Agent 导出目录",
    defaultPath,
  });

  return typeof selected === "string" ? selected : undefined;
}

export async function openProjectExportDirectory(outputDir: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  await invoke("open_project_export_dir", {
    request: {
      outputDir,
    },
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
