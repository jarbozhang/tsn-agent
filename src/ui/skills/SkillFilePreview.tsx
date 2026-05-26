import { useEffect, useMemo, useState } from "react";
import { FileText, Pencil } from "lucide-react";
import type { StageSkillName } from "../../agent/stage-skill-contract";
import {
  createSkillFileService,
  type SkillFileContent,
  type SkillFileEntry,
  type SkillFileListResult,
  type SkillFileService,
} from "../../skills/skill-file-service";

const defaultSkillFileService = createSkillFileService();

export function SkillFilePreview({
  skillId,
  service = defaultSkillFileService,
}: {
  skillId: StageSkillName;
  service?: SkillFileService;
}) {
  const [fileList, setFileList] = useState<SkillFileListResult>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState<SkillFileContent>();
  const [draft, setDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  const previewableFiles = useMemo(
    () => fileList?.files.filter((file) => file.canPreview) ?? [],
    [fileList],
  );
  const selectedFile = fileList?.files.find((file) => file.path === selectedPath);
  const hasDraftChanges = content ? draft !== content.content : false;

  useEffect(() => {
    let cancelled = false;

    setIsLoadingList(true);
    setError(undefined);
    setFileList(undefined);
    setContent(undefined);
    setSelectedPath(undefined);
    setIsEditing(false);

    service
      .listFiles(skillId)
      .then((result) => {
        if (cancelled) {
          return;
        }

        setFileList(result);
        const defaultPath =
          result.files.find((file) => file.path === "SKILL.md" && file.canPreview)?.path
          ?? result.files.find((file) => file.canPreview)?.path;
        setSelectedPath(defaultPath);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingList(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [service, skillId]);

  useEffect(() => {
    if (!selectedPath) {
      setContent(undefined);
      setDraft("");
      setIsEditing(false);
      return;
    }

    let cancelled = false;

    setIsLoadingContent(true);
    setError(undefined);
    setContent(undefined);
    setIsEditing(false);

    service
      .readFile(skillId, selectedPath)
      .then((result) => {
        if (cancelled) {
          return;
        }

        setContent(result);
        setDraft(result.content);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingContent(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [service, skillId, selectedPath]);

  function selectFile(file: SkillFileEntry) {
    if (!file.canPreview) {
      setError(file.reason ?? "该文件当前不可预览。");
      return;
    }

    setSelectedPath(file.path);
  }

  async function saveDraft() {
    if (!content || !hasDraftChanges || !content.editable) {
      return;
    }

    setIsSaving(true);
    setError(undefined);

    try {
      const saved = await service.writeFile(skillId, content.path, draft);
      setContent(saved);
      setDraft(saved.content);
      setIsEditing(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="skill-files-panel" aria-label="Skill 文件">
      <div className="skill-files-header">
        <div>
          <p className="drawer-kicker">Files</p>
          <h4>Skill 文件</h4>
          <small>编辑会保存到当前选中的 skill 文件。</small>
        </div>
        {fileList?.status && <span className={`skill-file-status ${fileList.status}`}>{rootStatusLabel(fileList.status)}</span>}
      </div>

      {error && <div className="skill-file-error">{error}</div>}

      {isLoadingList ? (
        <div className="empty-panel mono">正在加载 skill 文件...</div>
      ) : (
        <div className="skill-files-layout">
          <div className="skill-file-list" aria-label="Skill 文件列表">
            {fileList?.files.length ? (
              fileList.files.map((file) => (
                <button
                  className={selectedPath === file.path ? "skill-file-item active" : "skill-file-item"}
                  key={file.path}
                  type="button"
                  aria-selected={selectedPath === file.path}
                  onClick={() => selectFile(file)}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span className="mono">{file.path}</span>
                  <small>{file.canPreview ? formatSize(file.sizeBytes) : file.reason ?? "不可预览"}</small>
                </button>
              ))
            ) : (
              <div className="empty-panel mono">{fileList?.message ?? "暂无文件"}</div>
            )}
          </div>

          <div className="skill-file-preview">
            {isLoadingContent ? (
              <div className="empty-panel mono">正在读取文件...</div>
            ) : content ? (
              <>
                <div className="skill-file-preview-header">
                  <div>
                    <span className="mono">{content.path}</span>
                    {!content.editable && <small>{content.readonlyReason ?? "只读"}</small>}
                  </div>
                  <div className="skill-file-actions">
                    {isEditing ? (
                      <>
                        <button
                          className="btn-primary"
                          type="button"
                          onClick={saveDraft}
                          disabled={!hasDraftChanges || isSaving}
                        >
                          {isSaving ? "保存中..." : "保存"}
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => {
                            setDraft(content.content);
                            setIsEditing(false);
                          }}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => setIsEditing(true)}
                        disabled={!content.editable}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        编辑文件
                      </button>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <textarea
                    className="skill-file-editor mono"
                    value={draft}
                    aria-label="Skill 文件内容"
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : (
                  <pre className="skill-file-content">{content.content}</pre>
                )}
              </>
            ) : selectedFile && !selectedFile.canPreview ? (
              <div className="empty-panel mono">{selectedFile.reason ?? "该文件当前不可预览"}</div>
            ) : previewableFiles.length === 0 ? (
              <div className="empty-panel mono">暂无可预览文本文件</div>
            ) : (
              <div className="empty-panel mono">请选择一个文件</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function rootStatusLabel(status: SkillFileListResult["status"]): string {
  switch (status) {
    case "available":
      return "可编辑";
    case "readonly":
      return "只读";
    case "unavailable":
      return "暂无目录";
  }
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${Math.round(sizeBytes / 102.4) / 10} KB`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}
