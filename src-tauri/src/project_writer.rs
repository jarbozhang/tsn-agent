use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteProjectArtifactsRequest {
    output_dir: String,
    artifacts: Vec<ProjectArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestProjectExportDirRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectExportDirRequest {
    output_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArtifact {
    path: String,
    purpose: String,
    label: String,
    observed_external: Option<bool>,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteProjectArtifactsResponse {
    output_dir: String,
    written_files: Vec<String>,
}

#[tauri::command]
pub fn suggest_project_export_dir(
    app: tauri::AppHandle,
    request: SuggestProjectExportDirRequest,
) -> Result<String, String> {
    let documents_dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| format!("无法定位默认导出目录：{error}"))?;
    let session_slug = safe_path_segment(&request.session_id);

    Ok(documents_dir
        .join("TSN Agent")
        .join(session_slug)
        .display()
        .to_string())
}

#[tauri::command]
pub fn open_project_export_dir(
    app: tauri::AppHandle,
    request: OpenProjectExportDirRequest,
) -> Result<(), String> {
    let output_path = PathBuf::from(&request.output_dir);

    if !output_path.is_absolute() {
        return Err("项目导出目录必须是绝对路径。".to_string());
    }

    let normalized = normalize_path(&output_path)?;

    if !normalized.is_dir() {
        return Err(format!("导出目录不存在：{}", normalized.display()));
    }

    app.opener()
        .open_path(normalized.display().to_string(), None::<&str>)
        .map_err(|error| format!("无法打开导出目录：{error}"))
}

#[tauri::command]
pub async fn write_project_artifacts(
    app: tauri::AppHandle,
    request: WriteProjectArtifactsRequest,
) -> Result<WriteProjectArtifactsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || write_project_artifacts_blocking(app, request))
        .await
        .map_err(|error| format!("project writer task failed: {error}"))?
}

fn write_project_artifacts_blocking(
    app: tauri::AppHandle,
    request: WriteProjectArtifactsRequest,
) -> Result<WriteProjectArtifactsResponse, String> {
    validate_artifacts(&request.artifacts)?;
    let output_dir = assert_safe_project_path(&app, &request.output_dir)?;
    write_artifacts_to_dir(&output_dir, &request.artifacts)?;

    Ok(WriteProjectArtifactsResponse {
        output_dir: output_dir.display().to_string(),
        written_files: request
            .artifacts
            .into_iter()
            .map(|artifact| artifact.path)
            .collect(),
    })
}

fn write_artifacts_to_dir(output_dir: &Path, artifacts: &[ProjectArtifact]) -> Result<(), String> {
    std::fs::create_dir_all(output_dir).map_err(|error| format!("无法创建导出目录：{error}"))?;

    for artifact in artifacts {
        let destination = resolve_artifact_path(output_dir, &artifact.path)?;

        if destination.is_dir() {
            return Err(format!("导出文件目标是目录：{}", artifact.path));
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建导出目录：{error}"))?;
        }

        let temp_path = destination.with_extension(format!("tmp-{}", timestamp_nanos()));
        std::fs::write(&temp_path, &artifact.content)
            .map_err(|error| format!("无法写入临时文件 {}：{error}", artifact.path))?;
        std::fs::rename(&temp_path, &destination)
            .map_err(|error| format!("无法发布导出文件 {}：{error}", artifact.path))?;
    }

    Ok(())
}

fn validate_artifacts(artifacts: &[ProjectArtifact]) -> Result<(), String> {
    let mut paths = std::collections::HashSet::new();
    let mut manifest_content: Option<&str> = None;

    for artifact in artifacts {
        if !paths.insert(artifact.path.as_str()) {
            return Err(format!("导出文件重复：{}", artifact.path));
        }

        if artifact.path == "manifest.json" {
            manifest_content = Some(&artifact.content);
        }

        if artifact.purpose == "planner-output" && artifact.observed_external != Some(true) {
            return Err("planner-output 必须标记 observedExternal。".to_string());
        }

        if artifact.label.trim().is_empty() {
            return Err(format!("导出文件缺少 label：{}", artifact.path));
        }
    }

    let Some(manifest_content) = manifest_content else {
        return Err("导出文件缺少 manifest.json。".to_string());
    };
    let manifest: serde_json::Value = serde_json::from_str(manifest_content)
        .map_err(|error| format!("manifest.json 不是合法 JSON：{error}"))?;
    let files = manifest
        .get("files")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "manifest.json 缺少 files。".to_string())?;

    for file in files {
        let path = file
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "manifest files 缺少 path。".to_string())?;
        let purpose = file
            .get("purpose")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "manifest files 缺少 purpose。".to_string())?;
        let observed_external = file
            .get("observedExternal")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if purpose == "planner-output" {
            if path != "flow_plan_result_1.json" || !observed_external {
                return Err("规划器输出必须是外部观测到的 flow_plan_result_1.json。".to_string());
            }
            continue;
        }

        if !paths.contains(path) {
            return Err(format!("manifest 引用了未写入的文件：{path}"));
        }
    }

    Ok(())
}

fn assert_safe_project_path(app: &tauri::AppHandle, output_dir: &str) -> Result<PathBuf, String> {
    let output_path = PathBuf::from(output_dir);

    if !output_path.is_absolute() {
        return Err("项目导出目录必须是绝对路径。".to_string());
    }

    if output_path.exists() {
        let metadata = std::fs::symlink_metadata(&output_path)
            .map_err(|error| format!("无法检查导出目录：{error}"))?;

        if metadata.file_type().is_symlink() {
            return Err("拒绝通过 symlink 导出项目文件。".to_string());
        }

        if !metadata.is_dir() {
            return Err("项目导出路径必须是目录。".to_string());
        }
    }

    let normalized = normalize_path(&output_path)?;
    let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;
    let home_dir = std::env::var("HOME").ok().map(PathBuf::from);

    validate_protected_paths(
        &normalized,
        &root,
        &repo_root,
        &app_config_dir,
        home_dir.as_deref(),
    )?;

    Ok(normalized)
}

fn validate_protected_paths(
    normalized: &Path,
    root: &Path,
    repo_root: &Path,
    app_config_dir: &Path,
    home_dir: Option<&Path>,
) -> Result<(), String> {
    if same_path(normalized, root)
        || same_path(normalized, repo_root)
        || same_path(normalized, app_config_dir)
        || home_dir.is_some_and(|home| same_path(normalized, home))
    {
        return Err(format!("拒绝导出到危险目录：{}", normalized.display()));
    }

    if is_parent_or_same(repo_root, normalized) || is_parent_or_same(app_config_dir, normalized) {
        return Err(format!("拒绝导出到受保护目录内：{}", normalized.display()));
    }

    Ok(())
}

fn resolve_artifact_path(base_dir: &Path, artifact_path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(artifact_path);

    if relative.is_absolute() {
        return Err(format!("导出文件路径必须是相对路径：{artifact_path}"));
    }

    let resolved = base_dir.join(relative);

    if !is_parent_or_same(base_dir, &resolved) {
        return Err(format!("导出文件路径逃逸项目目录：{artifact_path}"));
    }

    Ok(resolved)
}

fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        path.canonicalize()
            .map_err(|error| format!("无法解析导出目录：{error}"))
    } else {
        Ok(path.to_path_buf())
    }
}

fn is_parent_or_same(parent: &Path, child: &Path) -> bool {
    let parent = normalize_for_compare(parent);
    let child = normalize_for_compare(child);

    child == parent || child.starts_with(parent)
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize_for_compare(left) == normalize_for_compare(right)
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

fn safe_path_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        "project".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_manifest_files() {
        let artifacts = vec![
            ProjectArtifact {
                path: "tsnagent/generated/network.ned".to_string(),
                purpose: "simulation-inet".to_string(),
                label: "INET".to_string(),
                observed_external: None,
                content: "network".to_string(),
            },
            ProjectArtifact {
                path: "omnetpp.ini".to_string(),
                purpose: "simulation-inet".to_string(),
                label: "INET ini".to_string(),
                observed_external: None,
                content: "[General]".to_string(),
            },
            ProjectArtifact {
                path: "manifest.json".to_string(),
                purpose: "manifest".to_string(),
                label: "manifest".to_string(),
                observed_external: None,
                content: r#"{"files":[{"path":"tsnagent/generated/network.ned","purpose":"simulation-inet"},{"path":"omnetpp.ini","purpose":"simulation-inet"}]}"#.to_string(),
            },
        ];

        assert!(validate_artifacts(&artifacts).is_ok());
    }

    #[test]
    fn rejects_manifest_references_without_artifact() {
        let artifacts = vec![ProjectArtifact {
            path: "manifest.json".to_string(),
            purpose: "manifest".to_string(),
            label: "manifest".to_string(),
            observed_external: None,
            content: r#"{"files":[{"path":"network.ned","purpose":"simulation-inet"}]}"#
                .to_string(),
        }];

        let error = validate_artifacts(&artifacts).expect_err("manifest should fail");

        assert!(error.contains("未写入"));
    }

    #[test]
    fn allows_observed_external_planner_result() {
        let artifacts = vec![ProjectArtifact {
            path: "manifest.json".to_string(),
            purpose: "manifest".to_string(),
            label: "manifest".to_string(),
            observed_external: None,
            content: r#"{"files":[{"path":"flow_plan_result_1.json","purpose":"planner-output","observedExternal":true}]}"#.to_string(),
        }];

        assert!(validate_artifacts(&artifacts).is_ok());
    }

    #[test]
    fn allows_export_inside_home_but_not_home_itself() {
        let root = PathBuf::from("/");
        let repo_root = PathBuf::from("/repo/tsn-agent");
        let app_config = PathBuf::from("/Users/test/Library/Application Support/com.tsnagent.app");
        let home = PathBuf::from("/Users/test");

        assert!(validate_protected_paths(
            Path::new("/Users/test/TSN Project"),
            &root,
            &repo_root,
            &app_config,
            Some(&home),
        )
        .is_ok());
        assert!(
            validate_protected_paths(&home, &root, &repo_root, &app_config, Some(&home)).is_err()
        );
        assert!(validate_protected_paths(
            Path::new("/repo/tsn-agent/export"),
            &root,
            &repo_root,
            &app_config,
            Some(&home),
        )
        .is_err());
    }

    #[test]
    fn sanitizes_suggested_path_segment() {
        assert_eq!(safe_path_segment("session-abc_123"), "session-abc_123");
        assert_eq!(safe_path_segment("../bad/session"), "bad-session");
        assert_eq!(safe_path_segment("   "), "project");
    }

    #[test]
    fn writes_artifacts_without_deleting_unrelated_files() {
        let output_dir =
            std::env::temp_dir().join(format!("tsn-agent-export-test-{}", timestamp_nanos()));
        std::fs::create_dir_all(&output_dir).expect("create temp export dir");
        std::fs::write(output_dir.join("notes.txt"), "keep").expect("write unrelated file");

        let artifacts = vec![
            ProjectArtifact {
                path: "tsnagent/generated/network.ned".to_string(),
                purpose: "simulation-inet".to_string(),
                label: "INET".to_string(),
                observed_external: None,
                content: "network".to_string(),
            },
            ProjectArtifact {
                path: "omnetpp.ini".to_string(),
                purpose: "simulation-inet".to_string(),
                label: "INET ini".to_string(),
                observed_external: None,
                content: "[General]".to_string(),
            },
            ProjectArtifact {
                path: "manifest.json".to_string(),
                purpose: "manifest".to_string(),
                label: "manifest".to_string(),
                observed_external: None,
                content: r#"{"files":[{"path":"tsnagent/generated/network.ned","purpose":"simulation-inet"},{"path":"omnetpp.ini","purpose":"simulation-inet"}]}"#.to_string(),
            },
        ];

        write_artifacts_to_dir(&output_dir, &artifacts).expect("write artifacts");

        assert_eq!(
            std::fs::read_to_string(output_dir.join("notes.txt")).expect("read unrelated file"),
            "keep",
        );
        assert_eq!(
            std::fs::read_to_string(output_dir.join("tsnagent/generated/network.ned"))
                .expect("read artifact"),
            "network",
        );
        assert_eq!(
            std::fs::read_to_string(output_dir.join("omnetpp.ini")).expect("read ini artifact"),
            "[General]",
        );

        std::fs::remove_dir_all(output_dir).expect("cleanup temp export dir");
    }
}
