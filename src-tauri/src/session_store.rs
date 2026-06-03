use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Pool, Row, Sqlite,
};
use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::OnceCell;

const CURRENT_SESSION_KEY: &str = "current_session_id";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    message_count: i64,
    event_count: i64,
    has_project: bool,
    project_name: Option<String>,
    bundle_file_count: i64,
    payload: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionRequest {
    session: SessionPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    session_id: String,
}

#[derive(Default)]
pub struct SessionStore {
    pool: OnceCell<Pool<Sqlite>>,
}

#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<SessionPayload>, String> {
    let pool = store.pool(&app).await?;
    let rows = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 12
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(db_error)?;

    Ok(rows.iter().map(row_to_payload).collect())
}

#[tauri::command]
pub async fn get_current_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Option<SessionPayload>, String> {
    let pool = store.pool(&app).await?;
    let current_id: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
            .bind(CURRENT_SESSION_KEY)
            .fetch_optional(pool)
            .await
            .map_err(db_error)?;

    if let Some(session_id) = current_id {
        if let Some(session) = select_session(pool, &session_id).await? {
            return Ok(Some(session));
        }
    }

    let latest = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;

    Ok(latest.as_ref().map(row_to_payload))
}

#[tauri::command]
pub async fn save_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SaveSessionRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let session = request.session;

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO sessions (
            id, title, created_at, updated_at, message_count, event_count,
            has_project, project_name, bundle_file_count, payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&session.id)
    .bind(&session.title)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .bind(session.message_count)
    .bind(session.event_count)
    .bind(if session.has_project { 1_i64 } else { 0_i64 })
    .bind(&session.project_name)
    .bind(session.bundle_file_count)
    .bind(&session.payload)
    .execute(pool)
    .await
    .map_err(db_error)?;

    set_current_session_id(pool, &session.id).await
}

#[tauri::command]
pub async fn set_current_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;

    set_current_session_id(pool, &request.session_id).await
}

#[tauri::command]
pub async fn remove_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let current_id = current_session_id(pool).await?;

    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .execute(pool)
        .await
        .map_err(db_error)?;
    crate::diagnostic_store::clear_logs_for_session(pool, &request.session_id).await?;

    if current_id.as_deref() != Some(request.session_id.as_str()) {
        return Ok(());
    }

    if let Some(next) = latest_session_id(pool).await? {
        set_current_session_id(pool, &next).await
    } else {
        sqlx::query("DELETE FROM app_state WHERE key = ?")
            .bind(CURRENT_SESSION_KEY)
            .execute(pool)
            .await
            .map_err(db_error)?;
        Ok(())
    }
}

impl SessionStore {
    async fn pool(&self, app: &tauri::AppHandle) -> Result<&Pool<Sqlite>, String> {
        self.pool
            .get_or_try_init(|| async { connect_app_database(app).await })
            .await
    }
}

pub async fn connect_app_database(app: &tauri::AppHandle) -> Result<Pool<Sqlite>, String> {
    let db_path = session_database_path(app)?;
    // Plan v3 U2a (Spike C 验证):
    // - sqlx 0.8 默认 journal_mode=Wal，无需显式 PRAGMA
    // - max_connections 由 1 提至 4 以支持后续 axum sidecar 并发读 + UI 写共享同一 pool
    // - busy_timeout=5000ms 在等待写锁时不立即返回 BUSY
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_millis(5_000));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(db_error)?;

    // Safety-net schema：v1 + v2（15 张 P0 表）全部 IF NOT EXISTS 幂等执行。
    // 与 tauri_plugin_sql migrations() 双写保险，避免 plugin migration 与
    // 直 sqlx 路径在不同 db 实例上的版本漂移（Spike C 已确认两者指向同一 db）。
    sqlx::query(&crate::db::safety_net_schema_sql())
        .execute(&pool)
        .await
        .map_err(db_error)?;

    Ok(pool)
}

async fn select_session(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<Option<SessionPayload>, String> {
    let row = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        WHERE id = ?
        LIMIT 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;

    Ok(row.as_ref().map(row_to_payload))
}

async fn set_current_session_id(pool: &Pool<Sqlite>, session_id: &str) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO app_state (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        "#,
    )
    .bind(CURRENT_SESSION_KEY)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(db_error)?;

    Ok(())
}

async fn latest_session_id(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}

async fn current_session_id(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
        .bind(CURRENT_SESSION_KEY)
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}

fn session_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;

    std::fs::create_dir_all(&app_dir).map_err(|error| format!("无法创建应用配置目录：{error}"))?;

    Ok(app_dir.join("tsn-agent.db"))
}

fn row_to_payload(row: &sqlx::sqlite::SqliteRow) -> SessionPayload {
    SessionPayload {
        id: row.get("id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        message_count: row.get("message_count"),
        event_count: row.get("event_count"),
        has_project: row.get::<i64, _>("has_project") == 1,
        project_name: row.get("project_name"),
        bundle_file_count: row.get("bundle_file_count"),
        payload: row.get("payload"),
    }
}

fn db_error(error: sqlx::Error) -> String {
    format!("session database error: {error}")
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Pool, Row, Sqlite};

    const EXPECTED_V1_TABLES: &[&str] = &["sessions", "app_state", "diagnostic_logs"];

    /// Plan v3 U2a schema 草案：15 张 P0 领域表。
    const EXPECTED_V2_TABLES: &[&str] = &[
        // topology.json (3)
        "topology_nodes",
        "topology_links",
        "topology_refs",
        // topo_feature.json (1)
        "topo_feature_links",
        // node.json (11)
        "nodes",
        "nodes_oss_cfg",
        "nodes_sdu_table_cfg",
        "nodes_gcl_cfg",
        "nodes_time_cfg",
        "nodes_psfg_stream_filters",
        "nodes_psfg_flow_meters",
        "nodes_psfg_stream_gates",
        "nodes_frer_cfg",
        "nodes_array_cfg",
        "nodes_object_cfg",
    ];

    #[test]
    fn session_schema_contains_expected_tables() {
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS sessions"));
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS app_state"));
        assert!(
            crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS diagnostic_logs")
        );
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("idx_sessions_updated_at"));
    }

    #[test]
    fn p0_domain_schema_lists_all_fifteen_tables() {
        let sql = crate::db::P0_DOMAIN_SCHEMA_SQL;
        for table in EXPECTED_V2_TABLES {
            let needle = format!("CREATE TABLE IF NOT EXISTS {table}");
            assert!(sql.contains(&needle), "missing {table} in P0 schema");
        }
        // application_id (0x54534E01 = 1414745601) 必须由 v2 migration 写入。
        assert!(sql.contains("PRAGMA application_id = 1414745601"));
    }

    #[test]
    fn migrations_expose_v1_and_v2_in_order() {
        let migs = crate::db::migrations();
        assert_eq!(migs.len(), 2);
        assert_eq!(migs[0].version, 1);
        assert_eq!(migs[0].description, "create_session_store");
        assert_eq!(migs[1].version, 2);
        assert_eq!(migs[1].description, "create_p0_domain_tables");
    }

    async fn fresh_memory_pool() -> Pool<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("memory sqlite");
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .expect("safety_net_schema_sql executes");
        pool
    }

    async fn list_tables(pool: &Pool<Sqlite>) -> Vec<String> {
        sqlx::query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .fetch_all(pool)
            .await
            .expect("list tables")
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect()
    }

    #[test]
    fn safety_net_schema_creates_all_v1_and_v2_tables_idempotently() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;

            let tables = list_tables(&pool).await;
            for expected in EXPECTED_V1_TABLES.iter().chain(EXPECTED_V2_TABLES.iter()) {
                assert!(
                    tables.iter().any(|t| t == expected),
                    "missing table {expected}; actual = {tables:?}"
                );
            }

            // Re-running the safety-net schema must remain idempotent.
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pool)
                .await
                .expect("idempotent re-run");

            let tables_again = list_tables(&pool).await;
            assert_eq!(tables, tables_again);
        });
    }

    #[test]
    fn safety_net_schema_applies_application_id_pragma() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;
            let app_id: i64 = sqlx::query_scalar("PRAGMA application_id")
                .fetch_one(&pool)
                .await
                .expect("application_id pragma");
            assert_eq!(app_id, 0x5453_4E01);
        });
    }

    #[test]
    fn nodes_subtable_foreign_key_cascade_works() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;
            // SQLite 内存库默认 PRAGMA foreign_keys=OFF；测试里手动启用以
            // 模拟生产 connect_app_database 的 .foreign_keys(true) 配置。
            sqlx::query("PRAGMA foreign_keys = ON")
                .execute(&pool)
                .await
                .expect("enable FK");

            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','t','t','{}')")
                .execute(&pool).await.expect("seed session");
            sqlx::query("INSERT INTO nodes (session_id, node_id) VALUES ('s1', 'n0')")
                .execute(&pool).await.expect("seed node");
            sqlx::query("INSERT INTO nodes_oss_cfg (session_id, node_id, cfg_json) VALUES ('s1','n0','{}')")
                .execute(&pool).await.expect("seed oss_cfg");

            // 删除 session → 应级联删除 nodes 与 nodes_oss_cfg。
            sqlx::query("DELETE FROM sessions WHERE id = 's1'")
                .execute(&pool).await.expect("delete session");

            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes")
                .fetch_one(&pool).await.expect("count nodes");
            let oss_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes_oss_cfg")
                .fetch_one(&pool).await.expect("count oss_cfg");
            assert_eq!(node_count, 0);
            assert_eq!(oss_count, 0);
        });
    }
}
