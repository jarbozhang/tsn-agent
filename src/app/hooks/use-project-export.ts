import { useCallback, useEffect, useState } from "react";
import { artifactBundleSummary, logDiagnostic } from "../../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";
import { createArtifactBundle } from "../../export/artifact-bundle";
import {
  exportProjectBundle,
  openProjectExportDirectory,
  selectProjectExportDirectory,
  suggestProjectExportDirectory,
  type ProjectExportResult,
} from "../../workflow/project-exporter";
import type { TsnSession } from "../../sessions/session-repository";
import type { PlannerRunState } from "../../planner/planner-contract";
import { normalizeError } from "../components/shared";

export interface UseProjectExportOptions {
  currentSession: TsnSession;
  diagnostics: DiagnosticLogRepository;
  persistSession: (next: TsnSession, options?: { logCategory?: "session" | "agent" | "artifact"; logMessage?: string; logDetails?: Record<string, unknown> }) => Promise<void>;
  /**
   * Called lazily by `refreshBundle` so this hook does not need to be ordered
   * after `usePlannerRun`. The getter is invoked at refresh time, not at
   * construction, so callers can safely close over a planner state that is
   * declared after `useProjectExport`.
   */
  getPlannerResultForCurrentProject: () => PlannerRunState["resultSnapshot"];
}

export interface UseProjectExportReturn {
  exportDirectory: string;
  setExportDirectory: (value: string) => void;
  exportResult: ProjectExportResult | undefined;
  exportError: string | undefined;
  setExportError: (value: string | undefined) => void;
  setExportResult: (value: ProjectExportResult | undefined) => void;
  canExport: boolean;
  canRefreshBundle: boolean;
  refreshBundle: () => Promise<void>;
  handleExportProject: () => Promise<void>;
  handleChooseExportDirectory: () => Promise<void>;
  handleOpenExportDirectory: () => Promise<void>;
}

export function useProjectExport(options: UseProjectExportOptions): UseProjectExportReturn {
  const { currentSession, diagnostics, persistSession, getPlannerResultForCurrentProject } = options;
  const project = currentSession.project;
  const bundle = currentSession.bundle;
  const workflow = currentSession.workflow;

  const [exportDirectory, setExportDirectory] = useState("");
  const [exportResult, setExportResult] = useState<ProjectExportResult | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();

  // On session change: clear export state + suggest output directory.
  useEffect(() => {
    let cancelled = false;
    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);

    async function loadSuggestedDirectory() {
      try {
        const suggestedDirectory = await suggestProjectExportDirectory({ sessionId: currentSession.id });
        if (!cancelled && suggestedDirectory) {
          setExportDirectory(suggestedDirectory);
        }
      } catch {
        // Browser mode does not provide a native project directory suggestion.
      }
    }

    void loadSuggestedDirectory();
    return () => {
      cancelled = true;
    };
  }, [currentSession.id]);

  const canExport = Boolean(bundle && workflow.currentStep === "planning-export");
  const canRefreshBundle = Boolean(
    project
      && workflow.currentStep === "planning-export"
      && ["waiting_confirmation", "confirmed"].includes(workflow.stages["planning-export"].status),
  );

  const refreshBundle = useCallback(async () => {
    if (!project || !canRefreshBundle) {
      return;
    }
    const nextBundle = createArtifactBundle(project, {
      plannerResult: getPlannerResultForCurrentProject(),
    });
    logDiagnostic(diagnostics, {
      sessionId: currentSession.id,
      category: "artifact",
      message: "刷新 artifact bundle",
      details: artifactBundleSummary(nextBundle),
    });
    await persistSession({
      ...currentSession,
      updatedAt: new Date().toISOString(),
      bundle: nextBundle,
      workflow,
    });
  }, [project, canRefreshBundle, getPlannerResultForCurrentProject, diagnostics, currentSession, workflow, persistSession]);

  const handleExportProject = useCallback(async () => {
    if (!bundle || !canExport) {
      return;
    }
    setExportError(undefined);
    try {
      const outputDir = exportDirectory.trim() || undefined;
      const result = await exportProjectBundle(bundle, outputDir);
      setExportResult(result);
      logDiagnostic(diagnostics, {
        sessionId: currentSession.id,
        category: "artifact",
        message: "项目文件已导出",
        details: {
          mode: result.mode,
          outputDir: result.outputDir,
          writtenFiles: result.writtenFiles,
        },
      });
    } catch (error) {
      const message = normalizeError(error);
      setExportError(message);
      logDiagnostic(diagnostics, {
        sessionId: currentSession.id,
        category: "artifact",
        level: "error",
        message: "项目文件导出失败",
        details: { error: message },
      });
    }
  }, [bundle, canExport, exportDirectory, currentSession.id, diagnostics]);

  const handleChooseExportDirectory = useCallback(async () => {
    try {
      const selectedDirectory = await selectProjectExportDirectory(exportDirectory || undefined);
      if (selectedDirectory) {
        setExportDirectory(selectedDirectory);
        setExportError(undefined);
      }
    } catch (error) {
      setExportError(normalizeError(error));
    }
  }, [exportDirectory]);

  const handleOpenExportDirectory = useCallback(async () => {
    if (!exportResult) {
      return;
    }
    try {
      await openProjectExportDirectory(exportResult.outputDir);
    } catch (error) {
      setExportError(normalizeError(error));
    }
  }, [exportResult]);

  return {
    exportDirectory,
    setExportDirectory,
    exportResult,
    exportError,
    setExportError,
    setExportResult,
    canExport,
    canRefreshBundle,
    refreshBundle,
    handleExportProject,
    handleChooseExportDirectory,
    handleOpenExportDirectory,
  };
}

