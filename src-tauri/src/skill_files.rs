use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{path::BaseDirectory, Manager};

const MAX_TEXT_FILE_BYTES: u64 = 256 * 1024;
const PROJECT_SKILL_ROOT: &str = ".claude/skills";
const SKILL_IDS: &[&str] = &[
    "tsn-topology",
    "tsn-time-sync",
    "tsn-flow-planning",
    "tsn-inet-export",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillFilesRequest {
    skill_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSkillFileRequest {
    skill_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillFileRequest {
    skill_id: String,
    path: String,
    content: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillFileRootStatus {
    Available,
    Readonly,
    Unavailable,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillFileKind {
    File,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    path: String,
    kind: SkillFileKind,
    size_bytes: u64,
    can_preview: bool,
    can_edit: bool,
    reason: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillFilesResponse {
    skill_id: String,
    status: SkillFileRootStatus,
    files: Vec<SkillFileEntry>,
    message: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContentResponse {
    skill_id: String,
    path: String,
    content: String,
    editable: bool,
    readonly_reason: Option<String>,
}

struct SkillRoot {
    path: PathBuf,
    writable: bool,
    status: SkillFileRootStatus,
}

#[tauri::command]
pub fn list_skill_files(
    app: tauri::AppHandle,
    request: ListSkillFilesRequest,
) -> Result<ListSkillFilesResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_skill_root(&app, &request.skill_id)?;

    if root.status == SkillFileRootStatus::Unavailable {
        return Ok(ListSkillFilesResponse {
            skill_id: request.skill_id,
            status: root.status,
            files: Vec::new(),
            message: Some("暂无可预览的 skill 文件目录。".to_string()),
        });
    }

    let files = list_skill_files_for_root(&root.path, root.writable)?;

    Ok(ListSkillFilesResponse {
        skill_id: request.skill_id,
        status: root.status,
        files,
        message: None,
    })
}

#[tauri::command]
pub fn read_skill_file(
    app: tauri::AppHandle,
    request: ReadSkillFileRequest,
) -> Result<SkillFileContentResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_existing_skill_root(&app, &request.skill_id)?;
    let path = resolve_existing_file(&root.path, &request.path)?;
    read_text_file(&request.skill_id, &root.path, &path, root.writable)
}

#[tauri::command]
pub fn write_skill_file(
    app: tauri::AppHandle,
    request: WriteSkillFileRequest,
) -> Result<SkillFileContentResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_existing_skill_root(&app, &request.skill_id)?;

    if !root.writable {
        return Err("该 skill 文件目录当前是只读资源，不能保存修改。".to_string());
    }

    if request.content.as_bytes().len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("文件内容超过轻量编辑大小限制。".to_string());
    }

    let path = resolve_existing_file(&root.path, &request.path)?;
    let entry = inspect_file(&root.path, &path, true)?;

    if !entry.can_edit {
        return Err(entry
            .reason
            .unwrap_or_else(|| "该文件当前不可编辑。".to_string()));
    }

    let temp_path = path.with_extension(format!("tmp-{}", timestamp_nanos()));
    std::fs::write(&temp_path, request.content)
        .map_err(|error| format!("无法写入临时 skill 文件：{error}"))?;
    std::fs::rename(&temp_path, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("无法保存 skill 文件：{error}")
    })?;

    read_text_file(&request.skill_id, &root.path, &path, root.writable)
}

fn resolve_existing_skill_root(
    app: &tauri::AppHandle,
    skill_id: &str,
) -> Result<SkillRoot, String> {
    let root = resolve_skill_root(app, skill_id)?;

    if root.status == SkillFileRootStatus::Unavailable {
        return Err("暂无可访问的 skill 文件目录。".to_string());
    }

    Ok(root)
}

fn resolve_skill_root(app: &tauri::AppHandle, skill_id: &str) -> Result<SkillRoot, String> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let development_root = repo_root.join(PROJECT_SKILL_ROOT).join(skill_id);

    if development_root.exists() {
        return Ok(SkillRoot {
            path: development_root
                .canonicalize()
                .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?,
            writable: true,
            status: SkillFileRootStatus::Available,
        });
    }

    if let Ok(resource_root) = app
        .path()
        .resolve(format!("{PROJECT_SKILL_ROOT}/{skill_id}"), BaseDirectory::Resource)
    {
        if resource_root.exists() {
            return Ok(SkillRoot {
                path: resource_root
                    .canonicalize()
                    .map_err(|error| format!("无法解析内置 skill 文件目录：{error}"))?,
                writable: false,
                status: SkillFileRootStatus::Readonly,
            });
        }
    }

    Ok(SkillRoot {
        path: development_root,
        writable: false,
        status: SkillFileRootStatus::Unavailable,
    })
}

fn validate_skill_id(skill_id: &str) -> Result<(), String> {
    if SKILL_IDS.contains(&skill_id) {
        Ok(())
    } else {
        Err(format!("未知 skill：{skill_id}"))
    }
}

fn list_skill_files_for_root(root: &Path, writable: bool) -> Result<Vec<SkillFileEntry>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?;
    let mut files = Vec::new();

    collect_skill_files(&root, &root, writable, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(files)
}

fn collect_skill_files(
    root: &Path,
    current: &Path,
    writable: bool,
    files: &mut Vec<SkillFileEntry>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(current)
        .map_err(|error| format!("无法读取 skill 文件目录 {}：{error}", current.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 skill 文件项：{error}"))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();

        if name == ".DS_Store" || name.ends_with(".swp") {
            continue;
        }

        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("无法检查 skill 文件 {}：{error}", path.display()))?;

        if metadata.file_type().is_symlink() {
            files.push(SkillFileEntry {
                path: relative_display_path(root, &path)?,
                kind: SkillFileKind::File,
                size_bytes: metadata.len(),
                can_preview: false,
                can_edit: false,
                reason: Some("symlink 文件不可预览。".to_string()),
            });
            continue;
        }

        if metadata.is_dir() {
            collect_skill_files(root, &path, writable, files)?;
            continue;
        }

        if metadata.is_file() {
            files.push(inspect_file(root, &path, writable)?);
        }
    }

    Ok(())
}

fn inspect_file(root: &Path, path: &Path, writable: bool) -> Result<SkillFileEntry, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查 skill 文件 {}：{error}", path.display()))?;
    let relative_path = relative_display_path(root, path)?;

    if metadata.file_type().is_symlink() {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("symlink 文件不可预览。".to_string()),
        });
    }

    if !metadata.is_file() {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("目录不可作为文本文件预览。".to_string()),
        });
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("文件超过轻量预览大小限制。".to_string()),
        });
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("无法读取 skill 文件 {}：{error}", path.display()))?;

    if String::from_utf8(bytes).is_err() {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("非 UTF-8 文本文件不可预览。".to_string()),
        });
    }

    Ok(SkillFileEntry {
        path: relative_path,
        kind: SkillFileKind::File,
        size_bytes: metadata.len(),
        can_preview: true,
        can_edit: writable,
        reason: if writable {
            None
        } else {
            Some("只读 skill 资源不可编辑。".to_string())
        },
    })
}

fn read_text_file(
    skill_id: &str,
    root: &Path,
    path: &Path,
    writable: bool,
) -> Result<SkillFileContentResponse, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?;
    let entry = inspect_file(&root, path, writable)?;

    if !entry.can_preview {
        return Err(entry
            .reason
            .unwrap_or_else(|| "该文件当前不可预览。".to_string()));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("无法读取 skill 文件 {}：{error}", entry.path))?;

    Ok(SkillFileContentResponse {
        skill_id: skill_id.to_string(),
        path: entry.path,
        content,
        editable: entry.can_edit,
        readonly_reason: if entry.can_edit { None } else { entry.reason },
    })
}

fn resolve_existing_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err("skill 文件路径不能为空。".to_string());
    }

    let relative = PathBuf::from(relative_path);

    if relative.is_absolute() {
        return Err(format!("skill 文件路径必须是相对路径：{relative_path}"));
    }

    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err(format!("skill 文件路径逃逸目录：{relative_path}"));
    }

    let root = root
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?;
    let candidate = root.join(relative);

    if !candidate.exists() {
        return Err(format!("skill 文件不存在：{relative_path}"));
    }

    let metadata = std::fs::symlink_metadata(&candidate)
        .map_err(|error| format!("无法检查 skill 文件：{error}"))?;

    if metadata.file_type().is_symlink() {
        return Err("拒绝访问 symlink skill 文件。".to_string());
    }

    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件：{error}"))?;

    if !is_parent_or_same(&root, &resolved) {
        return Err(format!("skill 文件路径逃逸目录：{relative_path}"));
    }

    Ok(resolved)
}

fn relative_display_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("skill 文件路径逃逸目录：{}", path.display()))?;

    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn is_parent_or_same(parent: &Path, child: &Path) -> bool {
    let parent = normalize_for_compare(parent);
    let child = normalize_for_compare(child);

    child == parent || child.starts_with(parent)
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    path.components().collect()
}

fn timestamp_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_nested_text_skill_files() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "name: test");
        write_file(&root.join("docs/rules.md"), "# rules");
        write_file(&root.join("tools/run.js"), "console.log('ok');");

        let files = list_skill_files_for_root(&root, true).expect("list skill files");

        assert_eq!(
            files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
            vec!["SKILL.md", "docs/rules.md", "tools/run.js"],
        );
        assert!(files.iter().all(|file| file.can_preview));
        assert!(files.iter().all(|file| file.can_edit));

        cleanup(root);
    }

    #[test]
    fn marks_binary_and_large_files_as_not_previewable() {
        let root = create_test_skill_root();
        std::fs::write(root.join("binary.bin"), [0, 159, 146, 150]).expect("write binary");
        std::fs::write(root.join("large.txt"), vec![b'a'; (MAX_TEXT_FILE_BYTES + 1) as usize])
            .expect("write large");

        let files = list_skill_files_for_root(&root, true).expect("list skill files");

        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| !file.can_preview));
        assert!(files.iter().all(|file| !file.can_edit));

        cleanup(root);
    }

    #[test]
    fn reads_and_writes_small_text_files() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "before");
        let path = resolve_existing_file(&root, "SKILL.md").expect("resolve file");

        let before = read_text_file("tsn-topology", &root, &path, true).expect("read file");
        assert_eq!(before.content, "before");
        assert!(before.editable);

        let temp_path = path.with_extension(format!("tmp-{}", timestamp_nanos()));
        std::fs::write(&temp_path, "after").expect("write temp");
        std::fs::rename(&temp_path, &path).expect("rename temp");

        let after = read_text_file("tsn-topology", &root, &path, true).expect("read file");
        assert_eq!(after.content, "after");

        cleanup(root);
    }

    #[test]
    fn rejects_escaping_and_absolute_paths() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "content");

        assert!(resolve_existing_file(&root, "../SKILL.md").is_err());
        assert!(resolve_existing_file(&root, "/tmp/SKILL.md").is_err());

        cleanup(root);
    }

    #[test]
    fn readonly_roots_can_preview_but_not_edit() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "content");
        let files = list_skill_files_for_root(&root, false).expect("list skill files");

        assert_eq!(files.len(), 1);
        assert!(files[0].can_preview);
        assert!(!files[0].can_edit);
        assert_eq!(files[0].reason.as_deref(), Some("只读 skill 资源不可编辑。"));

        cleanup(root);
    }

    fn create_test_skill_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "tsn-agent-skill-files-test-{}",
            timestamp_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create root");
        root
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, content).expect("write file");
    }

    fn cleanup(path: PathBuf) {
        std::fs::remove_dir_all(path).expect("cleanup test dir");
    }
}
