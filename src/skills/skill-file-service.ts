import { invoke } from "@tauri-apps/api/core";
import type { StageSkillName } from "../agent/stage-skill-contract";

export type SkillFileRootStatus = "available" | "readonly" | "unavailable";

export interface SkillFileEntry {
  path: string;
  kind: "file";
  sizeBytes: number;
  canPreview: boolean;
  canEdit: boolean;
  reason?: string;
}

export interface SkillFileListResult {
  skillId: StageSkillName;
  status: SkillFileRootStatus;
  files: SkillFileEntry[];
  message?: string;
}

export interface SkillFileContent {
  skillId: StageSkillName;
  path: string;
  content: string;
  editable: boolean;
  readonlyReason?: string;
}

export interface SkillFileService {
  listFiles(skillId: StageSkillName): Promise<SkillFileListResult>;
  readFile(skillId: StageSkillName, path: string): Promise<SkillFileContent>;
  writeFile(skillId: StageSkillName, path: string, content: string): Promise<SkillFileContent>;
}

export function createSkillFileService(): SkillFileService {
  if (!isTauriRuntime()) {
    return createBrowserSkillFileService();
  }

  return {
    listFiles(skillId) {
      return invoke<SkillFileListResult>("list_skill_files", {
        request: { skillId },
      });
    },
    readFile(skillId, path) {
      return invoke<SkillFileContent>("read_skill_file", {
        request: { skillId, path },
      });
    },
    writeFile(skillId, path, content) {
      return invoke<SkillFileContent>("write_skill_file", {
        request: { skillId, path, content },
      });
    },
  };
}

export function createBrowserSkillFileService(): SkillFileService {
  return {
    async listFiles(skillId) {
      return {
        skillId,
        status: "unavailable",
        files: [],
        message: "请在桌面应用中预览和编辑本地 skill 文件。",
      };
    },
    async readFile() {
      throw new Error("请在桌面应用中预览本地 skill 文件。");
    },
    async writeFile() {
      throw new Error("请在桌面应用中编辑本地 skill 文件。");
    },
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
