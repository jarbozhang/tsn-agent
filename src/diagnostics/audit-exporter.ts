import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export interface ExportRunAuditResult {
  kind: "exported" | "cancelled";
  destination?: string;
}

export interface ExportRunAuditInput {
  sessionId: string;
  runId: string;
}

const FALLBACK_FILENAME = (runId: string) => `agent-run-${runId}.json`;

export async function exportRunAudit(input: ExportRunAuditInput): Promise<ExportRunAuditResult> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error("仅在桌面运行时可导出 audit");
  }
  const destination = await save({
    title: "导出运行 audit",
    defaultPath: FALLBACK_FILENAME(input.runId),
    filters: [
      { name: "JSON", extensions: ["json"] },
    ],
  });
  if (!destination) {
    return { kind: "cancelled" };
  }
  const exported = await invoke<string>("export_run_audit", {
    request: {
      sessionId: input.sessionId,
      runId: input.runId,
      destination,
    },
  });
  return { kind: "exported", destination: exported };
}
