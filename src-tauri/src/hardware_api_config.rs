//! 硬件部署 API 配置（2026-06-26，U4）：tsn-sim HTTP 服务的 base_url 持久化 + 读写命令。
//!
//! 与软仿 SSH 配置（`InetHostConfig`）解耦，独立一套（KTD3）。完全镜像
//! `inet_sim_command.rs` 的 `get/set_inet_host_config`：app_state key、JSON 序列化、
//! env > UI > 默认 resolve。base_url 自用工具信任输入，仅校验非空 + http(s) 前缀。

use serde::{Deserialize, Serialize};

/// app_state 里硬件 API 配置的 key。
const HARDWARE_API_CONFIG_KEY: &str = "hardware_api_config";
/// 覆盖 base_url 的环境变量。
const HARDWARE_API_URL_ENV: &str = "TSN_AGENT_HARDWARE_API_URL";
/// dev 默认 base_url。
const DEFAULT_HARDWARE_API_URL: &str = "http://100.78.48.43:19080";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareApiConfig {
    /// tsn-sim 服务根地址（如 `http://100.78.48.43:19080`），序列化为 `baseUrl`。
    pub base_url: String,
}

/// base_url 合法性：非空 + http(s) 前缀（自用工具，不做严格字符集校验，同 base_dir 口径）。
fn is_valid_base_url(url: &str) -> bool {
    let u = url.trim();
    !u.is_empty() && (u.starts_with("http://") || u.starts_with("https://"))
}

/// 读 UI 持久的硬件 API 配置（app_state）。无记录 → None。
async fn load_hardware_config(pool: &sqlx::Pool<sqlx::Sqlite>) -> Option<HardwareApiConfig> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
            .bind(HARDWARE_API_CONFIG_KEY)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<HardwareApiConfig>(&s).ok())
}

/// 解析最终 base_url：env 覆盖 > UI 持久值 > dev 默认。
pub async fn resolve_hardware_api_url(pool: &sqlx::Pool<sqlx::Sqlite>) -> Result<String, String> {
    let env_url = std::env::var(HARDWARE_API_URL_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty());
    let resolved = match env_url {
        Some(u) => u,
        None => match load_hardware_config(pool).await {
            Some(cfg) => cfg.base_url,
            None => DEFAULT_HARDWARE_API_URL.to_string(),
        },
    };
    if !is_valid_base_url(&resolved) {
        return Err(format!(
            "硬件 API 地址 {resolved:?} 非法（需 http:// 或 https:// 前缀），请在设置里改正。"
        ));
    }
    Ok(resolved)
}

/// 读硬件 API 配置给设置面板展示：UI 持久值优先，无则播种当前默认。
#[tauri::command]
pub async fn get_hardware_api_config(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
) -> Result<HardwareApiConfig, String> {
    let pool = store.pool(&app).await?;
    if let Some(cfg) = load_hardware_config(pool).await {
        return Ok(cfg);
    }
    Ok(HardwareApiConfig {
        base_url: DEFAULT_HARDWARE_API_URL.to_string(),
    })
}

/// 写硬件 API 配置（设置面板保存）。落 app_state；写前校验非空 + http(s) 前缀。
#[tauri::command]
pub async fn set_hardware_api_config(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    config: HardwareApiConfig,
) -> Result<(), String> {
    if !is_valid_base_url(&config.base_url) {
        return Err("硬件 API 地址不能为空，且需 http:// 或 https:// 前缀。".to_string());
    }
    let pool = store.pool(&app).await?;
    let json = serde_json::to_string(&config).map_err(|e| format!("序列化配置失败：{e}"))?;
    sqlx::query(
        "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    )
    .bind(HARDWARE_API_CONFIG_KEY)
    .bind(&json)
    .execute(pool)
    .await
    .map_err(|e| format!("写配置失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn app_state_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = SqliteConnectOptions::new().in_memory(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE app_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn write_ui(pool: &sqlx::Pool<sqlx::Sqlite>, url: &str) {
        let json = serde_json::to_string(&HardwareApiConfig {
            base_url: url.to_string(),
        })
        .unwrap();
        sqlx::query(
            "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, 'now')",
        )
        .bind(HARDWARE_API_CONFIG_KEY)
        .bind(&json)
        .execute(pool)
        .await
        .unwrap();
    }

    #[test]
    fn valid_base_url_checks() {
        assert!(is_valid_base_url("http://h:19080"));
        assert!(is_valid_base_url("https://h"));
        assert!(!is_valid_base_url(""));
        assert!(!is_valid_base_url("   "));
        assert!(!is_valid_base_url("ftp://h"));
        assert!(!is_valid_base_url("100.78.48.43:19080"));
    }

    #[tokio::test]
    async fn no_ui_value_resolves_default() {
        let pool = app_state_pool().await;
        // 无 env 时（CI 一般无该 env）→ 默认。
        if std::env::var(HARDWARE_API_URL_ENV).is_err() {
            let url = resolve_hardware_api_url(&pool).await.unwrap();
            assert_eq!(url, DEFAULT_HARDWARE_API_URL);
        }
    }

    #[tokio::test]
    async fn ui_value_round_trips_and_resolves() {
        let pool = app_state_pool().await;
        write_ui(&pool, "http://10.0.0.9:19080").await;
        let cfg = load_hardware_config(&pool).await.unwrap();
        assert_eq!(cfg.base_url, "http://10.0.0.9:19080");
        if std::env::var(HARDWARE_API_URL_ENV).is_err() {
            let url = resolve_hardware_api_url(&pool).await.unwrap();
            assert_eq!(url, "http://10.0.0.9:19080");
        }
    }

    #[tokio::test]
    async fn invalid_persisted_url_rejected_on_resolve() {
        let pool = app_state_pool().await;
        write_ui(&pool, "not-a-url").await;
        if std::env::var(HARDWARE_API_URL_ENV).is_err() {
            assert!(resolve_hardware_api_url(&pool).await.is_err());
        }
    }
}
