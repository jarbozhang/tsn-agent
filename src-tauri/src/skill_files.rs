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
    /// 只读时的根级原因（如播种失败回退内置副本），穿透到 readonly_reason。
    reason: Option<String>,
}

/// skills 父根级决策结果（KTD1）：编辑器三命令与 worker spawn 共同消费。
pub struct EffectiveSkillRoot {
    pub path: PathBuf,
    pub writable: bool,
    status: SkillFileRootStatus,
    reason: Option<String>,
}

impl EffectiveSkillRoot {
    /// worker spawn 消费：可用（含只读兜底）时给出根路径，Unavailable 给 None。
    pub fn into_usable_path(self) -> Option<PathBuf> {
        if self.status == SkillFileRootStatus::Unavailable {
            None
        } else {
            Some(self.path)
        }
    }

    /// 诊断用根级原因（如播种失败回退/不可用原因），供 spawn 告警携带。
    pub fn diagnostics_reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }
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
            message: Some(
                root.reason
                    .unwrap_or_else(|| "暂无可预览的 skill 文件目录。".to_string()),
            ),
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
    read_text_file(&request.skill_id, &root.path, &path, root.writable, root.reason.as_deref())
}

#[tauri::command]
pub fn write_skill_file(
    app: tauri::AppHandle,
    request: WriteSkillFileRequest,
) -> Result<SkillFileContentResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_existing_skill_root(&app, &request.skill_id)?;

    if !root.writable {
        return Err(root
            .reason
            .clone()
            .unwrap_or_else(|| "该 skill 文件目录当前是只读资源，不能保存修改。".to_string()));
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

    read_text_file(&request.skill_id, &root.path, &path, root.writable, root.reason.as_deref())
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

/// 三个 skills 父根候选。dev 仅在 debug 构建给出（对齐 find_worker_path 的守卫，
/// 修复编辑器与 worker 解析不对称：release 构建在开发机上不得再选仓库路径）。
fn skill_root_candidates(
    app: &tauri::AppHandle,
) -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    let dev = if cfg!(debug_assertions) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        Some(repo_root.join(PROJECT_SKILL_ROOT))
    } else {
        None
    };
    let app_data = app.path().app_data_dir().ok().map(|dir| dir.join("skills"));
    let resource = app
        .path()
        .resolve(PROJECT_SKILL_ROOT, BaseDirectory::Resource)
        .ok();
    (dev, app_data, resource)
}

/// 有效 skills 父根（KTD1）：dev（仅 debug）→ app-data 懒播种可写副本 → Resource 只读兜底。
/// worker spawn（commands.rs）与编辑器三命令共同消费此决策。
pub fn effective_skill_root(app: &tauri::AppHandle) -> EffectiveSkillRoot {
    let (dev, app_data, resource) = skill_root_candidates(app);
    resolve_effective_root(dev.as_deref(), app_data.as_deref(), resource.as_deref())
}

/// 父根级决策纯函数：候选路径由调用方注入，可单测。
/// dev 命中时完全跳过播种（开发机不悄悄长出 app-data 副本）。
fn resolve_effective_root(
    dev: Option<&Path>,
    app_data: Option<&Path>,
    resource: Option<&Path>,
) -> EffectiveSkillRoot {
    if let Some(dev) = dev {
        if dev.exists() {
            return EffectiveSkillRoot {
                path: dev.to_path_buf(),
                writable: true,
                status: SkillFileRootStatus::Available,
                reason: None,
            };
        }
    }

    if let Some(app_data) = app_data {
        match ensure_seeded(app_data, resource) {
            Ok(()) => {
                return EffectiveSkillRoot {
                    path: app_data.to_path_buf(),
                    writable: true,
                    status: SkillFileRootStatus::Available,
                    reason: None,
                };
            }
            Err(reason) => {
                if let Some(resource) = resource {
                    if resource.exists() {
                        return EffectiveSkillRoot {
                            path: resource.to_path_buf(),
                            writable: false,
                            status: SkillFileRootStatus::Readonly,
                            reason: Some(format!("可写 skill 副本不可用（{reason}），当前为内置只读副本。")),
                        };
                    }
                }
                return EffectiveSkillRoot {
                    path: app_data.to_path_buf(),
                    writable: false,
                    status: SkillFileRootStatus::Unavailable,
                    reason: Some(reason),
                };
            }
        }
    }

    if let Some(resource) = resource {
        if resource.exists() {
            return EffectiveSkillRoot {
                path: resource.to_path_buf(),
                writable: false,
                status: SkillFileRootStatus::Readonly,
                reason: None,
            };
        }
    }

    EffectiveSkillRoot {
        path: app_data
            .or(dev)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(PROJECT_SKILL_ROOT)),
        writable: false,
        status: SkillFileRootStatus::Unavailable,
        reason: None,
    }
}

/// 懒播种（KTD3）：保证 app-data skills 根存在，并把内置资源里**实际存在**的
/// skill 目录按「目录缺失才播种」逐个补齐。每次解析都会重试上次失败的目录
/// （瞬时失败自愈）；个别目录播种失败不致命——该 skill 由 per-id 解析回退
/// 内置只读副本，其余 skill 不受影响。
fn ensure_seeded(app_data_root: &Path, resource: Option<&Path>) -> Result<(), String> {
    std::fs::create_dir_all(app_data_root)
        .map_err(|error| format!("无法创建可写 skill 目录：{error}"))?;

    let Some(resource) = resource else {
        return Ok(());
    };
    if !resource.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(resource)
        .map_err(|error| format!("无法读取内置 skill 目录：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取内置 skill 目录项：{error}"))?;
        let src = entry.path();
        let metadata = std::fs::symlink_metadata(&src)
            .map_err(|error| format!("无法检查内置 skill 目录项：{error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let dst = app_data_root.join(entry.file_name());
        if dst.exists() {
            continue; // R4：目录已播种即跳过，用户编辑保留。
        }
        // 个别目录播种失败不阻断其余目录（per-id 解析自行回退内置副本）。
        let _ = seed_skill_dir(&src, &dst);
    }
    Ok(())
}

/// 单个 skill 目录播种：复制到同父目录临时名再 rename 落位（同设备原子）。
fn seed_skill_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        return Ok(());
    }
    // tmp 名叠加 pid + 进程内序号：macOS SystemTime 仅微秒精度，并发首播
    // 同微秒会共用同一 tmp 目录，撕裂 rename 的原子性前提。
    let tmp = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        dst.with_extension(format!(
            "tmp-{}-{}-{}",
            timestamp_nanos(),
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    };
    if let Err(error) = copy_dir_skip_symlinks(src, &tmp) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(error);
    }
    finalize_seed(&tmp, dst)
}

/// rename 落位；失败后复查 dst——已存在视为并发播种者已赢得竞态（按成功处理），
/// 仅 dst 仍缺失才报错。
fn finalize_seed(tmp: &Path, dst: &Path) -> Result<(), String> {
    match std::fs::rename(tmp, dst) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_dir_all(tmp);
            if dst.exists() {
                Ok(())
            } else {
                Err(format!("无法落位 skill 副本目录：{error}"))
            }
        }
    }
}

/// 递归复制目录，跳过 symlink 条目（防内置资源内 symlink 被解引用复制进用户目录，
/// 对齐编辑器侧既有 symlink 守卫）。
fn copy_dir_skip_symlinks(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|error| format!("无法创建 skill 副本目录：{error}"))?;
    let entries = std::fs::read_dir(src)
        .map_err(|error| format!("无法读取 skill 源目录：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 skill 源目录项：{error}"))?;
        let from = entry.path();
        let metadata = std::fs::symlink_metadata(&from)
            .map_err(|error| format!("无法检查 skill 源文件：{error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let to = dst.join(entry.file_name());
        if metadata.is_dir() {
            copy_dir_skip_symlinks(&from, &to)?;
        } else if metadata.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("无法复制 skill 文件 {}：{error}", from.display()))?;
        }
    }
    Ok(())
}

fn resolve_skill_root(app: &tauri::AppHandle, skill_id: &str) -> Result<SkillRoot, String> {
    let effective = effective_skill_root(app);
    let resource_id_dir = app
        .path()
        .resolve(format!("{PROJECT_SKILL_ROOT}/{skill_id}"), BaseDirectory::Resource)
        .ok();
    resolve_skill_root_in(&effective, resource_id_dir.as_deref(), skill_id)
}

/// per-id 解析纯函数：有效父根 join skill_id；可写根下目录缺失（个别播种失败）时
/// 回退该 skill 的内置只读副本，资源也没有则维持既有 Unavailable 语义。
fn resolve_skill_root_in(
    effective: &EffectiveSkillRoot,
    resource_id_dir: Option<&Path>,
    skill_id: &str,
) -> Result<SkillRoot, String> {
    let id_dir = effective.path.join(skill_id);

    if effective.status != SkillFileRootStatus::Unavailable && id_dir.exists() {
        return Ok(SkillRoot {
            path: id_dir
                .canonicalize()
                .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?,
            writable: effective.writable,
            status: if effective.writable {
                SkillFileRootStatus::Available
            } else {
                SkillFileRootStatus::Readonly
            },
            reason: effective.reason.clone(),
        });
    }

    if let Some(resource_id_dir) = resource_id_dir {
        if resource_id_dir.exists() {
            return Ok(SkillRoot {
                path: resource_id_dir
                    .canonicalize()
                    .map_err(|error| format!("无法解析内置 skill 文件目录：{error}"))?,
                writable: false,
                status: SkillFileRootStatus::Readonly,
                reason: Some("该 skill 播种到可写目录失败，当前为内置只读副本。".to_string()),
            });
        }
    }

    Ok(SkillRoot {
        path: id_dir,
        writable: false,
        status: SkillFileRootStatus::Unavailable,
        // 根级不可用原因（如 app-data 创建失败）随 per-id 结果穿出，UI 如实显示。
        reason: effective.reason.clone(),
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
    root_reason: Option<&str>,
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
        readonly_reason: if entry.can_edit {
            None
        } else {
            // 根级原因（如播种失败回退内置副本）优先于通用 per-file 文案。
            root_reason.map(str::to_string).or(entry.reason)
        },
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

        let before = read_text_file("tsn-topology", &root, &path, true, None).expect("read file");
        assert_eq!(before.content, "before");
        assert!(before.editable);

        let temp_path = path.with_extension(format!("tmp-{}", timestamp_nanos()));
        std::fs::write(&temp_path, "after").expect("write temp");
        std::fs::rename(&temp_path, &path).expect("rename temp");

        let after = read_text_file("tsn-topology", &root, &path, true, None).expect("read file");
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

    #[test]
    fn effective_root_prefers_existing_dev_root_without_seeding() {
        let dev = create_test_skill_root();
        let app_data = unique_temp_path("tsn-skill-appdata");

        let effective = resolve_effective_root(Some(&dev), Some(&app_data), None);

        assert!(effective.writable);
        assert_eq!(effective.status, SkillFileRootStatus::Available);
        assert_eq!(effective.path, dev);
        assert!(!app_data.exists(), "dev 命中时不得触发 app-data 播种");

        cleanup(dev);
    }

    #[test]
    fn effective_root_seeds_app_data_once_and_preserves_user_edits() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        write_file(&resource.join("tsn-topology/package.json"), "{}");
        let app_data = unique_temp_path("tsn-skill-appdata");

        let first = resolve_effective_root(None, Some(&app_data), Some(&resource));
        assert!(first.writable);
        assert_eq!(first.status, SkillFileRootStatus::Available);
        assert_eq!(first.path, app_data);
        let seeded = app_data.join("tsn-topology/SKILL.md");
        assert_eq!(std::fs::read_to_string(&seeded).expect("seeded"), "factory");

        // 用户编辑后再次解析：目录已播种即跳过，不覆盖（R4）。
        std::fs::write(&seeded, "user-edited").expect("user edit");
        let second = resolve_effective_root(None, Some(&app_data), Some(&resource));
        assert!(second.writable);
        assert_eq!(std::fs::read_to_string(&seeded).expect("seeded"), "user-edited");

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn effective_root_preserves_unrelated_app_data_siblings() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let app_data = unique_temp_path("tsn-skill-appdata");
        // app-data 根下预置无关内容（如用户备份）——播种不得触碰（R6）。
        write_file(&app_data.join("backup-keep/db.bak"), "precious");

        let effective = resolve_effective_root(None, Some(&app_data), Some(&resource));

        assert!(effective.writable);
        assert_eq!(
            std::fs::read_to_string(app_data.join("backup-keep/db.bak")).expect("kept"),
            "precious"
        );

        cleanup(resource);
        cleanup(app_data);
    }

    #[cfg(unix)]
    #[test]
    fn seeding_skips_symlink_entries() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let outside = resource.join("outside.txt");
        std::fs::write(&outside, "secret").expect("write outside");
        std::os::unix::fs::symlink(&outside, resource.join("tsn-topology/link.txt"))
            .expect("create symlink");
        let app_data = unique_temp_path("tsn-skill-appdata");

        let effective = resolve_effective_root(None, Some(&app_data), Some(&resource));

        assert!(effective.writable);
        assert!(app_data.join("tsn-topology/SKILL.md").exists());
        assert!(
            !app_data.join("tsn-topology/link.txt").exists(),
            "symlink 条目不得被解引用复制进用户目录"
        );

        cleanup(resource);
        cleanup(app_data);
    }

    #[cfg(unix)]
    #[test]
    fn effective_root_falls_back_to_resource_readonly_when_app_data_unwritable() {
        use std::os::unix::fs::PermissionsExt;

        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let locked_parent = create_test_skill_root();
        std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o555))
            .expect("lock parent");
        let app_data = locked_parent.join("skills");

        let effective = resolve_effective_root(None, Some(&app_data), Some(&resource));

        assert!(!effective.writable);
        assert_eq!(effective.status, SkillFileRootStatus::Readonly);
        assert_eq!(effective.path, resource);
        assert!(effective.reason.is_some(), "回退必须带原因穿透 readonly_reason");

        std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o755))
            .expect("unlock parent");
        cleanup(resource);
        cleanup(locked_parent);
    }

    #[test]
    fn effective_root_unavailable_when_all_candidates_absent() {
        let missing_dev = unique_temp_path("tsn-skill-nodev");

        let effective = resolve_effective_root(Some(&missing_dev), None, None);

        assert!(!effective.writable);
        assert_eq!(effective.status, SkillFileRootStatus::Unavailable);
    }

    #[test]
    fn root_reason_takes_precedence_over_per_file_reason() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "content");
        let path = resolve_existing_file(&root, "SKILL.md").expect("resolve file");

        let with_root_reason =
            read_text_file("tsn-topology", &root, &path, false, Some("根级回退原因")).expect("read");
        assert!(!with_root_reason.editable);
        assert_eq!(with_root_reason.readonly_reason.as_deref(), Some("根级回退原因"));

        let without_root_reason =
            read_text_file("tsn-topology", &root, &path, false, None).expect("read");
        assert_eq!(
            without_root_reason.readonly_reason.as_deref(),
            Some("只读 skill 资源不可编辑。")
        );

        cleanup(root);
    }

    #[test]
    fn into_usable_path_maps_status_to_worker_consumption() {
        let usable = EffectiveSkillRoot {
            path: PathBuf::from("/tmp/x"),
            writable: false,
            status: SkillFileRootStatus::Readonly,
            reason: None,
        };
        assert_eq!(usable.into_usable_path(), Some(PathBuf::from("/tmp/x")));

        let unavailable = EffectiveSkillRoot {
            path: PathBuf::from("/tmp/x"),
            writable: false,
            status: SkillFileRootStatus::Unavailable,
            reason: None,
        };
        assert_eq!(unavailable.into_usable_path(), None);
    }

    #[test]
    fn finalize_seed_treats_concurrent_winner_as_success() {
        let base = create_test_skill_root();
        let tmp = base.join("tsn-topology.tmp-1");
        write_file(&tmp.join("SKILL.md"), "loser-copy");
        // 模拟并发赢家先落位：dst 已存在且非空 → rename 失败 → 复查按成功处理。
        let dst = base.join("tsn-topology");
        write_file(&dst.join("SKILL.md"), "winner-copy");

        finalize_seed(&tmp, &dst).expect("loser treated as success");

        assert!(!tmp.exists(), "输家临时目录必须被清理");
        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).expect("winner kept"),
            "winner-copy"
        );

        cleanup(base);
    }

    #[test]
    fn per_id_resolution_falls_back_to_resource_when_seeded_dir_missing() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let app_data = create_test_skill_root(); // 可写根存在但缺 tsn-topology（个别播种失败）

        let effective = EffectiveSkillRoot {
            path: app_data.clone(),
            writable: true,
            status: SkillFileRootStatus::Available,
            reason: None,
        };
        let resource_id = resource.join("tsn-topology");

        let root = resolve_skill_root_in(&effective, Some(&resource_id), "tsn-topology")
            .expect("resolve");
        assert!(!root.writable);
        assert_eq!(root.status, SkillFileRootStatus::Readonly);
        assert!(root.reason.is_some());

        // 资源也没有 → 维持既有 Unavailable 语义。
        let missing = resolve_skill_root_in(&effective, None, "tsn-time-sync").expect("resolve");
        assert_eq!(missing.status, SkillFileRootStatus::Unavailable);

        cleanup(resource);
        cleanup(app_data);
    }

    /// 唯一临时路径：macOS SystemTime 仅微秒精度，并行测试同微秒会撞名——
    /// 叠加进程内原子序号保证唯一。
    fn unique_temp_path(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            timestamp_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn create_test_skill_root() -> PathBuf {
        let root = unique_temp_path("tsn-agent-skill-files-test");
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
